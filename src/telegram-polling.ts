import { bot } from './telegram-client.ts';
import { processTelegramUpdate } from './channels/telegram.ts';

let started = false;
let configured = false;
let stopping = false;
let retryTimer: NodeJS.Timeout | undefined;
let retryDelayMs = 5000;
let state: { status: 'stopped' | 'starting' | 'running' | 'failed'; error?: string } = { status: 'stopped' };

export function getTelegramPollingState() {
  return state;
}

export function startTelegramPolling(): void {
  if (started || stopping) return;
  started = true;
  state = { status: 'starting' };
  if (!configured) {
    configured = true;
    bot.on('message', (context) => processTelegramUpdate(context.update));
    bot.on('edited_message', (context) => processTelegramUpdate(context.update));
    bot.on('callback_query', (context) => processTelegramUpdate(context.update));
    const stop = () => {
      stopping = true;
      if (retryTimer) clearTimeout(retryTimer);
      state = { status: 'stopped' };
      if (started) bot.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  void bot.start({
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    onStart: (info) => {
      state = { status: 'running' };
      retryDelayMs = 5000;
      console.log(`[telegram] polling as @${info.username}`);
    },
  }).catch((error) => {
    console.error('[telegram] polling stopped', error);
    started = false;
    state = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    if (!stopping) {
      retryTimer = setTimeout(() => startTelegramPolling(), retryDelayMs);
      retryTimer.unref();
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
    }
  });
}
