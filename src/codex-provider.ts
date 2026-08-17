import { resolve } from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { setProvider } from '@flue/runtime';
import { FileCredentialStore } from './file-credential-store.ts';

const credentialPath = resolve(
  process.env.PI_AUTH_FILE ?? process.env.SPIKE_AUTH_FILE ?? '.spike-secrets/pi-auth.json',
);

const nativeProvider = openaiCodexProvider();

export const codexAuth = createModels({
  credentials: new FileCredentialStore(credentialPath),
});

codexAuth.setProvider(nativeProvider);

export const flueCodexProvider = createProvider({
  id: nativeProvider.id,
  name: nativeProvider.name,
  baseUrl: nativeProvider.baseUrl,
  auth: {
    apiKey: {
      name: 'Application-managed Codex OAuth',
      check: async () => {
        const status = await codexAuth.checkAuth(nativeProvider.id);
        return status ? { type: 'api_key', source: 'Codex OAuth bridge' } : undefined;
      },
      resolve: async () => codexAuth.getAuth(nativeProvider.id),
    },
  },
  models: nativeProvider.getModels(),
  api: openAICodexResponsesApi(),
});

setProvider(flueCodexProvider);

export { credentialPath };
