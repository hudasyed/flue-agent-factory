import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { telegram } from '../telegram-client.ts';
import { createApproval, expireApproval, getApproval } from '../store.ts';
import { assertReadOnlyCommand } from './read-only-command.ts';
import {
  currentApprovedReview,
  listRepositories,
  prepareWorktree,
  promoteWorktree,
  recordReview,
  repositoryRoot,
  workspaceFingerprint,
} from '../workspaces.ts';

const execFileAsync = promisify(execFile);

export interface BoundTaskContext {
  sessionId: string;
  chatId: string;
}

export function repositoryTools(context: BoundTaskContext) {
  return [
    defineTool({
      name: 'list_repositories',
      description: 'List repositories available to this software factory under its configured repository root.',
      async run() {
        return { output: { root: repositoryRoot, repositories: await listRepositories() } };
      },
    }),
    defineTool({
      name: 'prepare_isolated_worktree',
      description: 'Create an isolated standalone git checkout and factory branch for this task. Use before modifying a repository.',
      input: v.object({
        repository: v.pipe(v.string(), v.minLength(1)),
        base: v.optional(v.string(), 'HEAD'),
      }),
      async run({ data }) {
        return { output: asJson(await prepareWorktree(context.sessionId, data.repository, data.base)) };
      },
    }),
  ] as const;
}

export function reviewerTools(context: BoundTaskContext) {
  return [
    ...repositoryTools(context),
    defineTool({
      name: 'record_software_review',
      description: 'Record the safety reviewer verdict for the exact current git state. Required after inspecting changes and tests.',
      input: v.object({
        verdict: v.picklist(['approved', 'changes_required']),
        summary: v.pipe(v.string(), v.minLength(1)),
      }),
      async run({ data }) {
        return { output: asJson(await recordReview(context.sessionId, data.verdict, data.summary)) };
      },
    }),
    inspectInfrastructureTool(),
    infrastructureChangeTool(context),
    promotionTool(context),
  ] as const;
}

export function operatorTools(context: BoundTaskContext) {
  return [...repositoryTools(context), inspectInfrastructureTool()] as const;
}

function inspectInfrastructureTool() {
  return defineTool({
    name: 'inspect_infrastructure',
    description: 'Run a read-only SSH command on an allowed infrastructure target. Mutating commands are rejected.',
    input: v.object({
      target: v.pipe(v.string(), v.minLength(1)),
      command: v.pipe(v.string(), v.minLength(1)),
    }),
    async run({ data, signal }) {
      assertAllowedTarget(data.target);
      assertReadOnlyCommand(data.command);
      const { stdout, stderr } = await execFileAsync('ssh', [data.target, data.command], {
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { output: { stdout, stderr } };
    },
  });
}

function infrastructureChangeTool(context: BoundTaskContext) {
  return defineTool({
    name: 'request_and_execute_infrastructure_change',
    description: 'Request owner approval in Telegram, then execute exactly one displayed SSH command if approved.',
    input: v.object({
      target: v.pipe(v.string(), v.minLength(1)),
      command: v.pipe(v.string(), v.minLength(1)),
      summary: v.pipe(v.string(), v.minLength(1)),
      risk: v.pipe(v.string(), v.minLength(1)),
    }),
    async run({ data, signal }) {
      if ((await workspaceFingerprint(context.sessionId)) && !(await currentApprovedReview(context.sessionId))) {
        throw new Error('Infrastructure execution for changed software requires an approved Reviewer verdict for the exact current checkout state');
      }
      assertAllowedTarget(data.target);
      const approval = await requestApproval(context, {
        kind: 'infrastructure',
        summary: data.summary,
        command: `ssh ${data.target} ${data.command}`,
        risk: data.risk,
      }, signal ?? new AbortController().signal);
      if (approval !== 'approved') return { output: { executed: false, decision: approval, stdout: null, stderr: null } };
      if ((await workspaceFingerprint(context.sessionId)) && !(await currentApprovedReview(context.sessionId))) {
        throw new Error('Workspace changed while approval was pending; infrastructure execution was cancelled');
      }
      const { stdout, stderr } = await execFileAsync('ssh', [data.target, data.command], {
        signal,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { output: { executed: true, decision: 'approved', stdout, stderr } };
    },
  });
}

function promotionTool(context: BoundTaskContext) {
  return defineTool({
    name: 'request_and_promote_worktree',
    description: 'Request owner approval, then explicitly merge the isolated factory branch into a target branch.',
    input: v.object({
      repository: v.pipe(v.string(), v.minLength(1)),
      targetBranch: v.pipe(v.string(), v.minLength(1)),
      summary: v.pipe(v.string(), v.minLength(1)),
      risk: v.pipe(v.string(), v.minLength(1)),
    }),
    async run({ data, signal }) {
      const review = await currentApprovedReview(context.sessionId);
      if (!review) {
        throw new Error('Promotion requires an approved Reviewer verdict for the exact current checkout state');
      }
      const approval = await requestApproval(context, {
        kind: 'promotion',
        summary: data.summary,
        command: `merge reviewed workspace ${review.fingerprint} for ${data.repository} into ${data.targetBranch}`,
        risk: data.risk,
      }, signal ?? new AbortController().signal);
      if (approval !== 'approved') return { output: { promoted: false, decision: approval, result: null } };
      return {
        output: {
          promoted: true,
          decision: 'approved',
          result: await promoteWorktree(context.sessionId, data.repository, data.targetBranch),
        },
      };
    },
  });
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

async function requestApproval(
  context: BoundTaskContext,
  input: { kind: 'infrastructure' | 'promotion'; summary: string; command: string; risk: string },
  signal: AbortSignal,
): Promise<'approved' | 'rejected' | 'expired'> {
  const approval = await createApproval({ ...context, ...input });
  try {
    await retry(async () => {
      await telegram.sendMessage(context.chatId, [
        `Approval required: ${approval.summary}`,
        '',
        `Action: ${approval.command}`,
        `Risk: ${approval.risk}`,
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `approval:approved:${approval.id}` },
            { text: 'Reject', callback_data: `approval:rejected:${approval.id}` },
          ]],
        },
      });
    }, signal);
  } catch (error) {
    await expireApproval(approval.id);
    throw error;
  }

  while (!signal.aborted) {
    const current = await getApproval(approval.id);
    if (!current || current.status === 'expired') return 'expired';
    if (current.status === 'approved' || current.status === 'rejected') return current.status;
    await delay(2000, signal);
  }
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function retry(task: () => Promise<void>, signal: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1000, signal);
    }
  }
  throw lastError;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function allowedTargets(): Set<string> {
  return new Set((process.env.INFRA_SSH_TARGETS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
}

function assertAllowedTarget(target: string): void {
  if (!allowedTargets().has(target)) throw new Error(`SSH target is not allowed: ${target}`);
}
