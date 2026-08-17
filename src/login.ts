import { codexAuth, credentialPath } from './codex-provider.ts';

const existing = await codexAuth.checkAuth('openai-codex');
if (existing) {
  console.log(`Codex OAuth is already configured in ${credentialPath}`);
  process.exit(0);
}

console.log('Starting OpenAI Codex device authorization...');

await codexAuth.login('openai-codex', 'oauth', {
  prompt: async (prompt) => {
    if (prompt.type === 'select') return 'device_code';
    throw new Error(`Unexpected OAuth prompt: ${prompt.type}`);
  },
  notify: (event) => {
    if (event.type === 'device_code') {
      console.log(`\nOpen: ${event.verificationUri}`);
      console.log(`Code: ${event.userCode}`);
      console.log(`Expires in: ${event.expiresInSeconds ?? 'unknown'} seconds\n`);
      return;
    }
    if (event.type === 'info' || event.type === 'progress') {
      console.log(event.message);
    }
  },
});

const resolved = await codexAuth.getAuth('openai-codex');
if (!resolved?.auth.apiKey) throw new Error('OAuth completed but no access token resolved');
console.log(`Codex OAuth connected and persisted to ${credentialPath}`);
