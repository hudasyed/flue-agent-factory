import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  sandboxFromDriver,
  type FileStat,
  type SandboxDriver,
  type SandboxFactory,
  type ShellResult,
} from '@flue/runtime';

const workspaceImage = process.env.WORKSPACE_IMAGE ?? 'flue-agent-workspace:local';

export function workspaceContainer(root: string): SandboxFactory {
  const lexicalRoot = resolve(root);
  return {
    async createSandbox() {
      await mkdir(lexicalRoot, { recursive: true });
      const physicalRoot = await realpath(lexicalRoot);
      const driver = createDriver(lexicalRoot, physicalRoot);
      return sandboxFromDriver(driver, lexicalRoot);
    },
  };
}

function createDriver(lexicalRoot: string, physicalRoot: string): SandboxDriver {
  return {
    async readFile(path) {
      return readFile(await safeExisting(path, lexicalRoot, physicalRoot), 'utf8');
    },
    async readFileBuffer(path) {
      return new Uint8Array(await readFile(await safeExisting(path, lexicalRoot, physicalRoot)));
    },
    async writeFile(path, content) {
      const target = await safeWritable(path, lexicalRoot, physicalRoot);
      await writeFile(target, content);
    },
    async stat(path): Promise<FileStat> {
      const lexical = safeLexical(path, lexicalRoot);
      const [followed, link] = await Promise.all([
        stat(await safeExisting(lexical, lexicalRoot, physicalRoot)),
        lstat(lexical),
      ]);
      return {
        isFile: followed.isFile(),
        isDirectory: followed.isDirectory(),
        isSymbolicLink: link.isSymbolicLink(),
        size: followed.size,
        mtime: followed.mtime,
      };
    },
    async readdir(path) {
      return readdir(await safeExisting(path, lexicalRoot, physicalRoot));
    },
    async exists(path) {
      try {
        await safeExisting(path, lexicalRoot, physicalRoot);
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path, options) {
      const target = await safeWritable(path, lexicalRoot, physicalRoot);
      await mkdir(target, { recursive: options?.recursive });
    },
    async rm(path, options) {
      const target = safeLexical(path, lexicalRoot);
      if (target === lexicalRoot) throw new Error('Refusing to remove the sandbox root');
      const parent = await realpath(dirname(target));
      assertPhysical(parent, physicalRoot);
      await rm(target, { recursive: options?.recursive, force: options?.force });
    },
    async exec(command, options) {
      const cwd = await safeExisting(options?.cwd ?? lexicalRoot, lexicalRoot, physicalRoot);
      return execInWorkspace(command, cwd, lexicalRoot, options);
    },
  };
}

async function execInWorkspace(
  command: string,
  cwd: string,
  workspaceRoot: string,
  options?: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<ShellResult> {
  const id = randomUUID();
  const containerName = `flue-task-${id}`;
  const args = [
    'run', '--rm', '--name', containerName, '--init',
    '--label', 'flue.agent.task=1',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
    '--tmpfs', '/root:rw,nosuid,nodev,size=1g',
    '--ulimit', 'nofile=4096:4096',
    '--pids-limit', process.env.WORKSPACE_PIDS_LIMIT ?? '512',
    '--memory', process.env.WORKSPACE_MEMORY_LIMIT ?? '4g',
    '--cpus', process.env.WORKSPACE_CPU_LIMIT ?? '4',
    '--workdir', cwd,
    '--volume', `${workspaceRoot}:${workspaceRoot}:rw`,
  ];
  for (const [key, value] of Object.entries(options?.env ?? {})) args.push('--env', `${key}=${value}`);
  args.push(workspaceImage, 'bash', '-lc', command);

  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    let settled = false;
    const child = execFile('docker', args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        resolvePromise({ stdout, stderr: `${stderr}\nCommand timed out.`.trim(), exitCode: 124 });
        return;
      }
      if (error && options?.signal?.aborted) {
        reject(new DOMException('Workspace command aborted', 'AbortError'));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0 });
    });

    const killRemote = () => {
      execFile('docker', [
        'stop', '--time', '2', containerName,
      ], () => undefined);
      child.kill('SIGTERM');
    };
    const onAbort = () => killRemote();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killRemote();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();

    function cleanup() {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  });
}

function safeLexical(path: string, root: string): string {
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path escapes the task workspace');
  return candidate;
}

async function safeExisting(path: string, lexicalRoot: string, physicalRoot: string): Promise<string> {
  const lexical = safeLexical(path, lexicalRoot);
  const physical = await realpath(lexical);
  assertPhysical(physical, physicalRoot);
  return lexical;
}

async function safeWritable(path: string, lexicalRoot: string, physicalRoot: string): Promise<string> {
  const lexical = safeLexical(path, lexicalRoot);
  try {
    const target = await lstat(lexical);
    if (target.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link');
    assertPhysical(await realpath(lexical), physicalRoot);
    return lexical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let cursor = dirname(lexical);
  while (true) {
    try {
      assertPhysical(await realpath(cursor), physicalRoot);
      return lexical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

function assertPhysical(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Symlink escapes the task workspace');
}
