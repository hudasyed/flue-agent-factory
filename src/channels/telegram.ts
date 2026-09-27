import { createTelegramChannel } from '@flue/telegram';
import { init } from '@flue/runtime';
import type { Message } from 'grammy/types';
import type { Update } from '@flue/telegram';
import { Orchestrator } from '../agents/orchestrator.ts';
import { telegram, sendTelegramText } from '../telegram-client.ts';
import {
  claimTelegramUpdate,
  completeTelegramUpdate,
  createSession,
  createTask,
  decideApproval,
  finishTask,
  getActiveSession,
  getSession,
  latestRunningTask,
  listRunningTasks,
  listSessions,
  listTasksAwaitingNotification,
  markTaskNotified,
  releaseTelegramUpdate,
  switchSession,
  type FactorySession,
} from '../store.ts';
import { ensureSessionWorkspace } from '../workspaces.ts';

const ownerUserId = requiredEnvironment('TELEGRAM_OWNER_USER_ID');
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET_TOKEN is required');
const watchedSubmissions = new Set<string>();
const deliveringSubmissions = new Set<string>();
let notificationRetryTimer: NodeJS.Timeout | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const channel = createTelegramChannel({
  secretToken: webhookSecret,
  async webhook({ update }) {
    await processTelegramUpdate(update);
  },
});

export async function processTelegramUpdate(update: Update): Promise<void> {
  if (!(await claimTelegramUpdate(update.update_id))) return;
  try {
    await routeTelegramUpdate(update);
    await completeTelegramUpdate(update.update_id);
  } catch (error) {
    await releaseTelegramUpdate(update.update_id).catch(() => undefined);
    throw error;
  }
}

async function routeTelegramUpdate(update: Update): Promise<void> {
  if (update.callback_query) {
    const query = update.callback_query;
    if (String(query.from.id) !== ownerUserId) return;
    await telegram.answerCallbackQuery(query.id);
    if (!query.message || !query.data) return;
    await handleCallback(String(query.message.chat.id), query.data);
    return;
  }

  const incoming = update.message ?? update.edited_message;
  if (!incoming?.from || String(incoming.from.id) !== ownerUserId) return;
  await handleMessage(incoming, update.update_id);
}

async function handleMessage(message: Message, updateId: number): Promise<void> {
  const chatId = String(message.chat.id);
  const body = messageBody(message).trim();
  if (!body) return;

  if (body === '/start' || body === '/help') {
    await sendTelegramText(chatId, helpText());
    return;
  }
  if (body === '/new' || body.startsWith('/new ')) {
    const session = await createSession(chatId, body.slice('/new'.length).trim(), updateId);
    await ensureSessionWorkspace(session.id);
    await sendTelegramText(chatId, `Started a new conversation: ${session.title}`);
    return;
  }
  if (body === '/sessions') {
    await sendSessionPicker(chatId);
    return;
  }
  if (body === '/status') {
    await sendStatus(chatId);
    return;
  }
  if (body === '/cancel') {
    await cancelActive(chatId);
    return;
  }
  if (body.startsWith('/switch ')) {
    const session = await switchSession(chatId, body.slice('/switch '.length).trim());
    await sendTelegramText(chatId, session
      ? `Switched to: ${session.title}`
      : 'Session not found. Use /sessions to list available sessions.');
    return;
  }

  const session = (await getActiveSession(chatId)) ?? await createSession(chatId, undefined, updateId);
  const workspacePath = await ensureSessionWorkspace(session.id);
  const handle = init(Orchestrator, { id: session.agentInstanceId });
  const receipt = await handle.dispatch({
    idempotencyKey: `telegram-update-${updateId}`,
    initialData: {
      sessionId: session.id,
      chatId,
      ownerUserId,
      workspacePath,
    },
    message: {
      kind: 'signal',
      type: 'telegram.owner_message',
      body,
      attributes: { updateId: String(updateId), ownerUserId },
    },
  });
  const task = await createTask(session.id, receipt.submissionId, body);
  if (task.status !== 'running') {
    if (!task.notifiedAt && task.resultText) {
      await deliverTaskNotification(session.chatId, task.submissionId, task.resultText);
    }
    return;
  }
  await telegram.sendMessage(chatId, `Working on “${session.title}”…`, {
    reply_parameters: { message_id: message.message_id },
  });
  startWatchingTask(session, receipt.submissionId);
}

async function watchTask(session: FactorySession, submissionId: string): Promise<void> {
  if (watchedSubmissions.has(submissionId)) return;
  watchedSubmissions.add(submissionId);
  const warning = setTimeout(() => {
    void sendTelegramText(session.chatId, `Still working on “${session.title}”; this task has been running for 10 minutes.`)
      .catch((error) => console.error('[telegram] failed to send task warning', error));
  }, 10 * 60 * 1000);
  warning.unref();
  let notification: string;
  try {
    const handle = init(Orchestrator, { id: session.agentInstanceId });
    const reply = await handle.read(submissionId);
    notification = reply.text || 'Task completed without a text response.';
    await finishTask(submissionId, 'completed', undefined, notification);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = /aborted/i.test(message);
    notification = aborted
      ? `The task in “${session.title}” was cancelled.`
      : `The task in “${session.title}” is stuck or failed: ${message}`;
    await finishTask(submissionId, aborted ? 'aborted' : 'failed', message, notification);
  } finally {
    clearTimeout(warning);
    watchedSubmissions.delete(submissionId);
  }
  await deliverTaskNotification(session.chatId, submissionId, notification);
}

export async function resumePendingTelegramTasks(): Promise<void> {
  const tasks = await listRunningTasks();
  await retryPendingNotifications();
  for (const task of tasks) {
    const session = await getSession(task.sessionId);
    if (session) startWatchingTask(session, task.submissionId);
  }
  if (!notificationRetryTimer) {
    notificationRetryTimer = setInterval(() => {
      void retryPendingNotifications()
        .catch((error) => console.error('[telegram] notification retry scan failed', error));
    }, 60_000);
    notificationRetryTimer.unref();
  }
}

function startWatchingTask(session: FactorySession, submissionId: string): void {
  void watchTask(session, submissionId)
    .catch((error) => console.error(`[telegram] task watcher failed ${submissionId}`, error));
}

async function deliverTaskNotification(chatId: string, submissionId: string, text: string): Promise<void> {
  if (deliveringSubmissions.has(submissionId)) return;
  deliveringSubmissions.add(submissionId);
  try {
    await sendTelegramText(chatId, text);
    await markTaskNotified(submissionId);
  } catch (error) {
    console.error(`[telegram] failed to deliver task result ${submissionId}`, error);
  } finally {
    deliveringSubmissions.delete(submissionId);
  }
}

async function retryPendingNotifications(): Promise<void> {
  const tasks = await listTasksAwaitingNotification();
  for (const task of tasks) {
    const session = await getSession(task.sessionId);
    if (session && task.resultText) void deliverTaskNotification(session.chatId, task.submissionId, task.resultText);
  }
}

async function handleCallback(chatId: string, data: string): Promise<void> {
  if (data.startsWith('session:')) {
    const session = await switchSession(chatId, data.slice('session:'.length));
    await sendTelegramText(chatId, session
      ? `Switched to: ${session.title}`
      : 'That session no longer exists.');
    return;
  }
  const match = /^approval:(approved|rejected):([0-9a-f-]+)$/.exec(data);
  if (!match) return;
  const approval = await decideApproval(match[2], chatId, match[1] as 'approved' | 'rejected');
  await sendTelegramText(chatId, approval
    ? `${match[1] === 'approved' ? 'Approved' : 'Rejected'}: ${approval.summary}`
    : 'That approval is invalid, expired, or already decided.');
}

async function sendSessionPicker(chatId: string): Promise<void> {
  const sessions = await listSessions(chatId, 10);
  if (sessions.length === 0) {
    await sendTelegramText(chatId, 'No sessions yet. Use /new to start one.');
    return;
  }
  await telegram.sendMessage(chatId, 'Choose a session:', {
    reply_markup: {
      inline_keyboard: sessions.map((session) => [{
        text: `${session.title} · ${session.status}`.slice(0, 60),
        callback_data: `session:${session.id}`,
      }]),
    },
  });
}

async function sendStatus(chatId: string): Promise<void> {
  const session = await getActiveSession(chatId);
  if (!session) {
    await sendTelegramText(chatId, 'No active session. Use /new to start one.');
    return;
  }
  const task = await latestRunningTask(session.id);
  await sendTelegramText(chatId, [
    `Conversation: ${session.title}`,
    `Status: ${session.status}`,
    task ? `Running since: ${task.startedAt}` : 'No task is currently running.',
  ].join('\n'));
}

async function cancelActive(chatId: string): Promise<void> {
  const session = await getActiveSession(chatId);
  if (!session) {
    await sendTelegramText(chatId, 'No active session.');
    return;
  }
  const task = await latestRunningTask(session.id);
  if (!task) {
    await sendTelegramText(chatId, 'The active session has no running task.');
    return;
  }
  await init(Orchestrator, { id: session.agentInstanceId }).abort();
  await sendTelegramText(chatId, `Cancellation requested for “${session.title}”.`);
}

function messageBody(message: Message): string {
  if (message.text !== undefined) return message.text;
  if (message.caption !== undefined) return message.caption;
  if (message.photo) return '[photo message]';
  if (message.video) return '[video message]';
  if (message.voice) return '[voice message]';
  if (message.document) return '[document message]';
  return '';
}

function helpText(): string {
  return [
    'Software Factory commands',
    '/new [title] — start a new isolated session',
    '/sessions — list and switch sessions',
    '/switch <id> — switch by full or short session id',
    '/status — show the active task',
    '/cancel — abort active work',
    '/help — show this message',
    '',
    'Send any other message to the active Orchestrator session.',
  ].join('\n');
}
