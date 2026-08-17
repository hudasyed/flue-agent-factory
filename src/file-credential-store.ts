import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type CredentialFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = await this.readAll();
      const next = await fn(all[providerId]);
      if (next !== undefined) {
        all[providerId] = next;
        await this.writeAll(all);
      }
      return next ?? all[providerId];
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.readAll();
      if (all[providerId] === undefined) return;
      delete all[providerId];
      await this.writeAll(all);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readAll(): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async writeAll(credentials: CredentialFile): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporaryPath, 'w', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
