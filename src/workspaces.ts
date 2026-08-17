import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const operationChains = new Map<string, Promise<unknown>>();
export const repositoryRoot = resolve(process.env.REPOSITORY_ROOT ?? '/srv/flue-agent/repositories');
export const taskRoot = resolve(process.env.TASK_WORKTREE_ROOT ?? '/srv/flue-agent/tasks');
export const factoryStateRoot = resolve(process.env.FACTORY_STATE_ROOT ?? '/srv/flue-agent/state');

export interface WorktreeMetadata {
  sessionId: string;
  repository: string;
  sourcePath: string;
  worktreePath: string;
  branch: string;
  base: string;
  createdAt: string;
}

export interface ReviewRecord {
  verdict: 'approved' | 'changes_required';
  summary: string;
  fingerprint: string;
  reviewedAt: string;
}

export function sessionWorkspace(sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return join(taskRoot, sessionId);
}

export async function ensureSessionWorkspace(sessionId: string): Promise<string> {
  const path = sessionWorkspace(sessionId);
  await Promise.all([
    mkdir(path, { recursive: true }),
    mkdir(sessionStateDirectory(sessionId), { recursive: true, mode: 0o700 }),
  ]);
  return path;
}

export async function listRepositories(): Promise<string[]> {
  const entries = await readdir(repositoryRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const repositories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(repositoryRoot, entry.name);
    try {
      const { stdout } = await execFileAsync('git', ['-C', candidate, 'rev-parse', '--is-inside-work-tree']);
      if (stdout.trim() === 'true') repositories.push(entry.name);
    } catch {
      // Non-git directories are not exposed.
    }
  }
  return repositories.sort();
}

export async function assertNoLegacyWorkspaceState(): Promise<void> {
  const sessions = await readdir(taskRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const legacy: string[] = [];
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const files = await readdir(join(taskRoot, session.name, '.factory')).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    if (files.some((file) => file.endsWith('.json') && file !== 'review.json')) legacy.push(session.name);
  }
  if (legacy.length > 0) {
    throw new Error(`Legacy shared-git workspaces require migration before startup: ${legacy.join(', ')}`);
  }
}

export function prepareWorktree(sessionId: string, repository: string, base = 'HEAD'): Promise<WorktreeMetadata> {
  return withOperationLock(`prepare:${sessionId}:${repository}`, () => prepareWorktreeUnlocked(sessionId, repository, base));
}

async function prepareWorktreeUnlocked(sessionId: string, repository: string, base: string): Promise<WorktreeMetadata> {
  assertSafeSegment(repository, 'repository');
  if (base.startsWith('-') || !/^[A-Za-z0-9._/@{}~^:+-]+$/.test(base)) throw new Error('Invalid base revision');
  let existing: WorktreeMetadata | undefined;
  try {
    existing = await readWorktreeMetadata(sessionId, repository);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    await execFileAsync('git', ['-C', existing.worktreePath, 'rev-parse', '--git-dir']);
    return existing;
  }
  const sourcePath = safeChild(repositoryRoot, repository);
  await execFileAsync('git', ['-C', sourcePath, 'rev-parse', '--git-dir']);
  const { stdout: baseCommitOutput } = await execFileAsync('git', ['-C', sourcePath, 'rev-parse', '--verify', `${base}^{commit}`]);
  const baseCommit = baseCommitOutput.trim();
  const workspace = await ensureSessionWorkspace(sessionId);
  const worktreePath = join(workspace, 'repositories', repository);
  await mkdir(dirname(worktreePath), { recursive: true });
  const branch = `factory/${sessionId.slice(0, 8)}/${Date.now()}`;
  const temporaryPath = `${worktreePath}.creating-${randomUUID()}`;
  try {
    // A standalone clone keeps the execution container away from the source
    // repository's working tree and shared git metadata.
    await execFileAsync('git', ['clone', '--no-local', '--no-hardlinks', '--no-checkout', sourcePath, temporaryPath], {
      maxBuffer: 16 * 1024 * 1024,
    });
    await execFileAsync('git', ['-C', temporaryPath, 'checkout', '-b', branch, baseCommit]);
    await execFileAsync('git', ['-C', temporaryPath, 'remote', 'remove', 'origin']);
    const [userName, userEmail] = await Promise.all([
      repositoryGitConfig(sourcePath, 'user.name', process.env.FACTORY_GIT_USER_NAME ?? 'Flue Software Factory'),
      repositoryGitConfig(sourcePath, 'user.email', process.env.FACTORY_GIT_USER_EMAIL ?? 'flue-agent@localhost'),
    ]);
    await execFileAsync('git', ['-C', temporaryPath, 'config', 'user.name', userName]);
    await execFileAsync('git', ['-C', temporaryPath, 'config', 'user.email', userEmail]);
    await rename(temporaryPath, worktreePath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const metadata: WorktreeMetadata = {
    sessionId,
    repository,
    sourcePath,
    worktreePath,
    branch,
    base,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(metadataPath(sessionId, repository), metadata);
  return metadata;
}

export async function readWorktreeMetadata(sessionId: string, repository: string): Promise<WorktreeMetadata> {
  assertSafeSegment(repository, 'repository');
  const metadata = JSON.parse(await readFile(metadataPath(sessionId, repository), 'utf8')) as WorktreeMetadata;
  await validateMetadata(metadata, sessionId, repository);
  return metadata;
}

export async function workspaceFingerprint(sessionId: string): Promise<string | null> {
  const directory = sessionStateDirectory(sessionId);
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.json') && name !== 'review.json')
    .sort();
  if (files.length === 0) return null;
  const states: unknown[] = [];
  for (const file of files) {
    const metadata = JSON.parse(await readFile(join(directory, file), 'utf8')) as WorktreeMetadata;
    await validateMetadata(metadata, sessionId, metadata.repository);
    const [{ stdout: head }, { stdout: status }, { stdout: diff }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', ['-C', metadata.worktreePath, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', metadata.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all']),
      execFileAsync('git', ['-C', metadata.worktreePath, 'diff', '--binary', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }),
      execFileAsync('git', ['-C', metadata.worktreePath, 'ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const untrackedHashes = await Promise.all(untracked.split('\0').filter(Boolean).sort().map(async (path) => {
      const file = await lstat(join(metadata.worktreePath, path));
      if (!file.isFile() && !file.isSymbolicLink()) throw new Error(`Unsupported untracked file type: ${path}`);
      const { stdout } = await execFileAsync(
        'git',
        ['-C', metadata.worktreePath, 'hash-object', '--no-filters', '--', path],
        { timeout: 30_000 },
      );
      return { path, hash: stdout.trim() };
    }));
    states.push({ repository: metadata.repository, head: head.trim(), status, diff, untrackedHashes });
  }
  return createHash('sha256').update(JSON.stringify(states)).digest('hex');
}

export async function recordReview(
  sessionId: string,
  verdict: ReviewRecord['verdict'],
  summary: string,
): Promise<ReviewRecord> {
  const fingerprint = await workspaceFingerprint(sessionId);
  if (!fingerprint) throw new Error('No prepared worktree exists for this session');
  if (verdict === 'approved') await assertWorkspaceClean(sessionId);
  const review: ReviewRecord = { verdict, summary, fingerprint, reviewedAt: new Date().toISOString() };
  await writeJsonAtomic(join(sessionStateDirectory(sessionId), 'review.json'), review);
  return review;
}

export async function currentApprovedReview(sessionId: string): Promise<ReviewRecord | null> {
  const fingerprint = await workspaceFingerprint(sessionId);
  if (!fingerprint) return null;
  try {
    const review = JSON.parse(
      await readFile(join(sessionStateDirectory(sessionId), 'review.json'), 'utf8'),
    ) as ReviewRecord;
    return review.verdict === 'approved' && review.fingerprint === fingerprint ? review : null;
  } catch {
    return null;
  }
}

export function promoteWorktree(sessionId: string, repository: string, targetBranch: string): Promise<string> {
  return withOperationLock(`promote:${repository}`, () => promoteWorktreeUnlocked(sessionId, repository, targetBranch));
}

async function promoteWorktreeUnlocked(sessionId: string, repository: string, targetBranch: string): Promise<string> {
  if (!(await currentApprovedReview(sessionId))) {
    throw new Error('Promotion requires an approved review for the exact current workspace state');
  }
  await assertWorkspaceClean(sessionId);
  const metadata = await readWorktreeMetadata(sessionId, repository);
  await execFileAsync('git', ['check-ref-format', '--branch', targetBranch]);
  await execFileAsync('git', ['-C', metadata.sourcePath, 'show-ref', '--verify', `refs/heads/${targetBranch}`]);
  const { stdout: targetCommitOutput } = await execFileAsync(
    'git', ['-C', metadata.sourcePath, 'rev-parse', `refs/heads/${targetBranch}`],
  );
  const targetCommit = targetCommitOutput.trim();
  const { stdout: sourceStatus } = await execFileAsync('git', [
    '-C', metadata.sourcePath, 'status', '--porcelain=v1', '--untracked-files=all',
  ]);
  if (sourceStatus.trim()) throw new Error('Source repository has local changes; refusing promotion');

  const promotionRef = `refs/flue/promotions/${randomUUID()}`;
  const { stdout: originalHead } = await execFileAsync('git', ['-C', metadata.sourcePath, 'rev-parse', 'HEAD']);
  const { stdout: originalBranchOutput } = await execFileAsync('git', ['-C', metadata.sourcePath, 'branch', '--show-current']);
  const originalBranch = originalBranchOutput.trim();
  const [userName, userEmail] = await Promise.all([
    repositoryGitConfig(metadata.sourcePath, 'user.name', process.env.FACTORY_GIT_USER_NAME ?? 'Flue Software Factory'),
    repositoryGitConfig(metadata.sourcePath, 'user.email', process.env.FACTORY_GIT_USER_EMAIL ?? 'flue-agent@localhost'),
  ]);
  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: userName,
    GIT_AUTHOR_EMAIL: userEmail,
    GIT_COMMITTER_NAME: userName,
    GIT_COMMITTER_EMAIL: userEmail,
  };
  let checkoutChanged = false;
  const promotionDirectory = await mkdtemp(join(factoryStateRoot, '.promotion-'));
  try {
    await execFileAsync('git', [
      'clone', '--no-local', '--no-hardlinks', '--no-checkout', metadata.sourcePath, promotionDirectory,
    ], { maxBuffer: 16 * 1024 * 1024 });
    await execFileAsync('git', ['-C', promotionDirectory, 'checkout', '--detach', targetCommit]);
    const candidateRef = `refs/flue/candidates/${randomUUID()}`;
    await execFileAsync('git', [
      '-C', promotionDirectory, 'fetch', '--no-tags', metadata.worktreePath, `HEAD:${candidateRef}`,
    ], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!(await currentApprovedReview(sessionId))) {
      throw new Error('Workspace changed while promotion was being prepared');
    }
    const { stdout: preparedOutput, stderr: preparedError } = await execFileAsync(
      'git',
      ['-C', promotionDirectory, 'merge', '--no-ff', candidateRef, '-m', `Promote ${metadata.branch}`],
      { maxBuffer: 16 * 1024 * 1024, env: gitEnvironment },
    );
    await execFileAsync('git', [
      '-C', metadata.sourcePath, 'fetch', '--no-tags', promotionDirectory, `HEAD:${promotionRef}`,
    ], { maxBuffer: 16 * 1024 * 1024 });
    if (!(await currentApprovedReview(sessionId))) {
      throw new Error('Workspace changed before promotion could be applied');
    }

    const [{ stdout: currentTarget }, { stdout: finalSourceStatus }] = await Promise.all([
      execFileAsync('git', ['-C', metadata.sourcePath, 'rev-parse', `refs/heads/${targetBranch}`]),
      execFileAsync('git', ['-C', metadata.sourcePath, 'status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    if (currentTarget.trim() !== targetCommit) throw new Error('Target branch changed while promotion was being prepared');
    if (finalSourceStatus.trim()) throw new Error('Source repository changed while promotion was being prepared');
    const { stdout: currentBranch } = await execFileAsync('git', ['-C', metadata.sourcePath, 'branch', '--show-current']);
    if (currentBranch.trim() !== targetBranch) {
      await execFileAsync('git', ['-C', metadata.sourcePath, 'checkout', targetBranch]);
      checkoutChanged = true;
    }
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', metadata.sourcePath, 'merge', '--ff-only', promotionRef],
      { maxBuffer: 16 * 1024 * 1024, env: gitEnvironment },
    );
    return `${preparedOutput}${preparedError}${stdout}${stderr}`.trim();
  } catch (error) {
    await execFileAsync('git', ['-C', metadata.sourcePath, 'merge', '--abort']).catch(() => undefined);
    if (checkoutChanged) {
      const restore = originalBranch
        ? ['-C', metadata.sourcePath, 'checkout', originalBranch]
        : ['-C', metadata.sourcePath, 'checkout', '--detach', originalHead.trim()];
      await execFileAsync('git', restore).catch(() => undefined);
    }
    throw error;
  } finally {
    await execFileAsync('git', ['-C', metadata.sourcePath, 'update-ref', '-d', promotionRef]).catch(() => undefined);
    await rm(promotionDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function metadataPath(sessionId: string, repository: string): string {
  return join(sessionStateDirectory(sessionId), `${repository}.json`);
}

function sessionStateDirectory(sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return join(factoryStateRoot, sessionId);
}

async function assertWorkspaceClean(sessionId: string): Promise<void> {
  const files = (await readdir(sessionStateDirectory(sessionId)).catch(() => []))
    .filter((name) => name.endsWith('.json') && name !== 'review.json');
  for (const file of files) {
    const metadata = JSON.parse(await readFile(join(sessionStateDirectory(sessionId), file), 'utf8')) as WorktreeMetadata;
    await validateMetadata(metadata, sessionId, metadata.repository);
    const { stdout } = await execFileAsync('git', [
      '-C', metadata.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all',
    ]);
    if (stdout.trim()) throw new Error(`Repository ${metadata.repository} has uncommitted changes; commit or remove them before approval`);
  }
}

async function validateMetadata(metadata: WorktreeMetadata, sessionId: string, repository: string): Promise<void> {
  assertSafeSegment(repository, 'repository');
  if (metadata.sessionId !== sessionId || metadata.repository !== repository) throw new Error('Invalid worktree metadata');
  if (metadata.sourcePath !== safeChild(repositoryRoot, repository)) throw new Error('Worktree source path is outside the repository root');
  const expectedWorktree = join(sessionWorkspace(sessionId), 'repositories', repository);
  if (resolve(metadata.worktreePath) !== expectedWorktree) throw new Error('Worktree path is outside the session workspace');
  const [physicalTask, physicalWorktree, physicalRepositories, physicalSource] = await Promise.all([
    realpath(sessionWorkspace(sessionId)),
    realpath(metadata.worktreePath),
    realpath(repositoryRoot),
    realpath(metadata.sourcePath),
  ]);
  assertPhysicalChild(physicalTask, physicalWorktree, 'Worktree');
  assertPhysicalChild(physicalRepositories, physicalSource, 'Repository');
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function repositoryGitConfig(repository: string, key: string, fallback: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repository, 'config', '--get', key]);
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

function assertPhysicalChild(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} path escapes its configured root`);
}

function withOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operationChains.set(key, current);
  void current.finally(() => {
    if (operationChains.get(key) === current) operationChains.delete(key);
  }).catch(() => undefined);
  return current;
}

function safeChild(root: string, child: string): string {
  const candidate = resolve(root, child);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Path escapes configured root');
  return candidate;
}

function assertSafeSegment(value: string, label: string): void {
  if (basename(value) !== value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}
