'use agent';

import { useModel, type ThinkingLevel } from '@flue/runtime';
import '../codex-provider.ts';

export function SpikeAgent() {
  useModel(process.env.SPIKE_MODEL ?? 'openai-codex/gpt-5.6-sol', {
    thinkingLevel: (process.env.SPIKE_THINKING ?? 'medium') as ThinkingLevel,
  });

  return 'Follow the user instruction exactly. Do not add commentary.';
}
