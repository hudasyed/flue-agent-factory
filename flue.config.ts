import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
  app: 'src/app.ts',
  db: 'src/db.ts',
  agents: 'agents/**/*.ts',
  providers: ['minimax', 'openai-codex'],
});
