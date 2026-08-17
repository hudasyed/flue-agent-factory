import type { AuthEvent } from '@earendil-works/pi-ai';
import { codexAuth, credentialPath } from './codex-provider.ts';

export type OpenAIAuthState = {
  status: 'disconnected' | 'starting' | 'waiting' | 'connected' | 'error';
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
  error?: string;
  credentialPath: string;
};

let state: OpenAIAuthState = { status: 'disconnected', credentialPath };
let activeLogin: Promise<void> | null = null;

export async function getOpenAIAuthState(): Promise<OpenAIAuthState> {
  if (state.status !== 'starting' && state.status !== 'waiting') {
    try {
      const configured = await codexAuth.checkAuth('openai-codex');
      state = { status: configured ? 'connected' : 'disconnected', credentialPath };
    } catch (error) {
      state = { status: 'error', error: errorMessage(error), credentialPath };
    }
  }
  return state;
}

export function startOpenAIDeviceAuth(): OpenAIAuthState {
  if (activeLogin) return state;
  state = { status: 'starting', credentialPath };
  activeLogin = codexAuth
    .login('openai-codex', 'oauth', {
      prompt: async (prompt) => {
        if (prompt.type === 'select') return 'device_code';
        throw new Error(`Unexpected OpenAI OAuth prompt: ${prompt.type}`);
      },
      notify: onAuthEvent,
    })
    .then(() => {
      state = { status: 'connected', credentialPath };
    })
    .catch((error) => {
      state = { status: 'error', error: errorMessage(error), credentialPath };
    })
    .finally(() => {
      activeLogin = null;
    });
  return state;
}

export async function logoutOpenAI(): Promise<void> {
  if (activeLogin) throw new Error('An authorization attempt is still active');
  await codexAuth.logout('openai-codex');
  state = { status: 'disconnected', credentialPath };
}

function onAuthEvent(event: AuthEvent): void {
  if (event.type !== 'device_code') return;
  state = {
    status: 'waiting',
    verificationUri: event.verificationUri,
    userCode: event.userCode,
    expiresAt: event.expiresInSeconds
      ? new Date(Date.now() + event.expiresInSeconds * 1000).toISOString()
      : undefined,
    credentialPath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
