'use agent';

import {
  useAgentFinish,
  useInitialData,
  useModel,
  useSandbox,
  useSubagent,
} from '@flue/runtime';
import * as v from 'valibot';
import '../codex-provider.ts';
import { workspaceContainer } from '../sandbox/workspace-container.ts';
import { specialists } from '../subagents/specialists.ts';
import { currentApprovedReview, workspaceFingerprint } from '../workspaces.ts';

const initialData = v.object({
  sessionId: v.string(),
  chatId: v.string(),
  ownerUserId: v.string(),
  workspacePath: v.string(),
});

export function Orchestrator() {
  useModel('minimax/MiniMax-M3', { thinkingLevel: 'high' });
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('Orchestrator requires session creation data');

  useSandbox(workspaceContainer(data.workspacePath));

  for (const specialist of specialists({ sessionId: data.sessionId, chatId: data.chatId })) {
    useSubagent(specialist);
  }

  useAgentFinish(async ({ append }) => {
    const review = await currentApprovedReview(data.sessionId);
    const hasWorktree = review !== null || (await workspaceFingerprint(data.sessionId)) !== null;
    if (!hasWorktree || review) return;
    append({
      kind: 'signal',
      type: 'software_review_required',
      body: 'The isolated checkout has unreviewed changes. Delegate the exact current state to the reviewer and do not declare completion until it records an approved review.',
    });
  });

  return [
    'You are Orchestrator, the owner’s sole front door to a private software factory.',
    'Manage the session, clarify intent when materially necessary, and delegate substantial specialist work with complete self-contained briefs.',
    'Use researcher for investigation, developer for implementation, operator for production hardening, and reviewer as the mandatory final safety guardrail.',
    'Specialists have isolated context; include all relevant requirements, paths, findings, constraints, and expected outputs in every delegation prompt.',
    'Parallelize independent research, but sequence implementation, operations hardening, and final review when they touch the same worktree.',
    'All code changes must occur in a task-specific isolated git checkout and be committed before final approval.',
    'Only the reviewer may promote work or execute infrastructure changes, and those tools require the owner’s Telegram approval for the exact action.',
    'Never treat an approval as permission for a broader or different action.',
    'Report outcomes plainly, including completion, blockers, timeouts, worktree/branch location, validation, and anything awaiting approval.',
    'For ordinary conversation that needs no tools, answer directly.',
  ].join('\n');
}

Orchestrator.agentName = 'orchestrator';
Orchestrator.initialData = initialData;
Orchestrator.durability = { maxAttempts: 5, timeoutMs: 30 * 60 * 1000 };
