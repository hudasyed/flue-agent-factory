import type { SubagentDefinition } from '@flue/runtime';
import { useTool } from '@flue/runtime';
import { operatorTools, repositoryTools, reviewerTools, type BoundTaskContext } from '../tools/factory-tools.ts';

export function specialists(context: BoundTaskContext): SubagentDefinition[] {
  function Researcher() {
    for (const tool of repositoryTools(context)) useTool(tool);
    return [
      'You are the Researcher in a private software factory.',
      'Investigate focused questions using available repositories, the shared sandbox, and network retrieval when useful.',
      'Do not modify repositories or infrastructure.',
      'Return concise findings, evidence, uncertainties, and recommended next steps to the Orchestrator.',
    ].join('\n');
  }

  function Developer() {
    for (const tool of repositoryTools(context)) useTool(tool);
    return [
      'You are the Developer. Implement requested software features and fixes.',
      'Before modifying a repository, create or reuse this task session’s isolated checkout.',
      'Work only inside the isolated checkout, inspect existing conventions, run proportionate tests, and commit the complete reviewed state.',
      'Do not deploy, merge into shared branches, or mutate infrastructure.',
      'Return changed paths, tests, remaining risks, and the worktree branch to the Orchestrator.',
    ].join('\n');
  }

  function Operator() {
    for (const tool of operatorTools(context)) useTool(tool);
    return [
      'You are the Operator. Make software scalable, reliable, maintainable, observable, and deployable.',
      'You may inspect infrastructure and improve deployment configuration inside isolated checkouts.',
      'Produce concrete deployment and rollback plans.',
      'You cannot perform infrastructure mutations or promote branches; the Reviewer owns those guarded actions.',
      'Return operational findings, validation, risks, and a deployment plan to the Orchestrator.',
    ].join('\n');
  }

  function Reviewer() {
    for (const tool of reviewerTools(context)) useTool(tool);
    return [
      'You are the final safety guardrail and strongest operator in this private software factory.',
      'You have access to repository, infrastructure inspection, promotion, and approved infrastructure-change tools.',
      'Independently inspect the complete diff, tests, security boundaries, reliability, deployment plan, and rollback path.',
      'Record a software review against the exact current committed checkout state; approval rejects uncommitted changes.',
      'If changes are unsafe or incomplete, record changes_required and state precise corrections.',
      'Only after an approved review may you request owner approval for promotion or infrastructure mutation.',
      'Never split, broaden, or alter the displayed action after the owner approves it.',
    ].join('\n');
  }

  return [
    {
      name: 'researcher',
      description: 'Investigates focused technical or external questions without making changes.',
      agent: Researcher,
      model: 'minimax/MiniMax-M3',
      thinkingLevel: 'high',
    },
    {
      name: 'developer',
      description: 'Implements features and fixes inside isolated git checkouts and validates them.',
      agent: Developer,
      model: 'openai-codex/gpt-5.6-luna',
      thinkingLevel: 'xhigh',
    },
    {
      name: 'operator',
      description: 'Hardens software for scalability, reliability, maintenance, observability, and deployment.',
      agent: Operator,
      model: 'openai-codex/gpt-5.6-luna',
      thinkingLevel: 'xhigh',
    },
    {
      name: 'reviewer',
      description: 'Required final safety review; owns guarded promotion and infrastructure execution after owner approval.',
      agent: Reviewer,
      model: 'openai-codex/gpt-5.6-sol',
      thinkingLevel: 'medium',
    },
  ];
}
