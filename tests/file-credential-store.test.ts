import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../src/file-credential-store.ts';

describe('FileCredentialStore', () => {
  it('persists credentials with restrictive permissions and serializes updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-credentials-'));
    const path = join(root, 'secrets', 'auth.json');
    const store = new FileCredentialStore(path);

    await Promise.all([
      store.modify('openai-codex', async () => ({
        type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 60_000,
      })),
      store.modify('minimax', async () => ({ type: 'api_key', key: 'key-1' })),
    ]);

    expect((await store.read('openai-codex'))?.type).toBe('oauth');
    expect(await store.list()).toEqual(expect.arrayContaining([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'minimax', type: 'api_key' },
    ]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('openai-codex.access', 'access-1');

    await store.delete('minimax');
    expect(await store.read('minimax')).toBeUndefined();
  });
});
