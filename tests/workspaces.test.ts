import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

afterEach(() => {
  delete process.env.REPOSITORY_ROOT;
  delete process.env.TASK_WORKTREE_ROOT;
  delete process.env.FACTORY_STATE_ROOT;
  vi.resetModules();
});

describe('isolated checkouts and review fingerprinting', () => {
  it('creates a task branch and invalidates a stale approval after changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-worktrees-'));
    const repositories = join(root, 'repositories');
    const tasks = join(root, 'tasks');
    const state = join(root, 'state');
    const source = join(repositories, 'sample');
    await mkdir(source, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: source });

    process.env.REPOSITORY_ROOT = repositories;
    process.env.TASK_WORKTREE_ROOT = tasks;
    process.env.FACTORY_STATE_ROOT = state;
    const workspace = await import('../src/workspaces.ts');
    const [metadata, concurrentMetadata] = await Promise.all([
      workspace.prepareWorktree('session-1', 'sample', 'main'),
      workspace.prepareWorktree('session-1', 'sample', 'main'),
    ]);

    expect(metadata.branch).toMatch(/^factory\/session-/);
    expect(concurrentMetadata).toEqual(metadata);
    expect((await stat(join(metadata.worktreePath, '.git'))).isDirectory()).toBe(true);
    expect(await workspace.listRepositories()).toEqual(['sample']);
    await writeFile(join(metadata.worktreePath, 'README.md'), 'changed\n');
    await expect(workspace.recordReview('session-1', 'approved', 'Looks safe')).rejects.toThrow('uncommitted changes');
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: metadata.worktreePath });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: metadata.worktreePath });
    await execFileAsync('git', ['add', 'README.md'], { cwd: metadata.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'change'], { cwd: metadata.worktreePath });
    const review = await workspace.recordReview('session-1', 'approved', 'Looks safe');
    expect(await workspace.currentApprovedReview('session-1')).toEqual(review);

    await writeFile(join(metadata.worktreePath, 'README.md'), 'changed again\n');
    expect(await workspace.currentApprovedReview('session-1')).toBeNull();

    const untracked = join(metadata.worktreePath, 'untracked.txt');
    await writeFile(untracked, 'first\n');
    const firstFingerprint = await workspace.workspaceFingerprint('session-1');
    await writeFile(untracked, 'second\n');
    expect(await workspace.workspaceFingerprint('session-1')).not.toBe(firstFingerprint);
  });

  it('promotes only committed and reviewed changes into a clean source repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-promotion-'));
    const repositories = join(root, 'repositories');
    const source = join(repositories, 'sample');
    await mkdir(source, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: source });

    process.env.REPOSITORY_ROOT = repositories;
    process.env.TASK_WORKTREE_ROOT = join(root, 'tasks');
    process.env.FACTORY_STATE_ROOT = join(root, 'state');
    const workspace = await import('../src/workspaces.ts');
    const metadata = await workspace.prepareWorktree('session-2', 'sample', 'main');
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: metadata.worktreePath });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: metadata.worktreePath });
    await writeFile(join(metadata.worktreePath, 'README.md'), 'promoted\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: metadata.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'promoted change'], { cwd: metadata.worktreePath });
    await workspace.recordReview('session-2', 'approved', 'Approved');

    await workspace.promoteWorktree('session-2', 'sample', 'main');
    const { stdout: contents } = await execFileAsync('git', ['show', 'main:README.md'], { cwd: source });
    const { stdout: parents } = await execFileAsync('git', ['show', '-s', '--format=%P', 'main'], { cwd: source });
    expect(contents).toBe('promoted\n');
    expect(parents.trim().split(' ')).toHaveLength(2);

    const conflicting = await workspace.prepareWorktree('session-3', 'sample', 'main');
    await writeFile(join(conflicting.worktreePath, 'README.md'), 'task version\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: conflicting.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'task version'], { cwd: conflicting.worktreePath });
    await workspace.recordReview('session-3', 'approved', 'Approved conflict test');
    await writeFile(join(source, 'README.md'), 'source version\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'source version'], { cwd: source });

    await expect(workspace.promoteWorktree('session-3', 'sample', 'main')).rejects.toThrow();
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: source });
    const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], { cwd: source });
    expect(status).toBe('');
    expect(branch.trim()).toBe('main');
  });
});

describe('workspace sandbox path confinement', () => {
  it('rejects a symlink that escapes the task root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-sandbox-'));
    const outside = join(root, '..', 'outside-secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'escape'));
    const { workspaceContainer } = await import('../src/sandbox/workspace-container.ts');
    const sandbox = await workspaceContainer(root).createSandbox({ id: 'test' });
    await expect(sandbox.readFile('escape')).rejects.toThrow('Symlink escapes');
    await expect(sandbox.writeFile('escape', 'overwritten')).rejects.toThrow('symbolic link');
  });
});

describe('workspace upgrade safety', () => {
  it('refuses to trust legacy shared-git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-legacy-'));
    const legacy = join(root, 'tasks', 'session-old', '.factory');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'sample.json'), '{}\n');
    process.env.TASK_WORKTREE_ROOT = join(root, 'tasks');
    process.env.FACTORY_STATE_ROOT = join(root, 'state');
    const workspace = await import('../src/workspaces.ts');
    await expect(workspace.assertNoLegacyWorkspaceState()).rejects.toThrow('Legacy shared-git workspaces');
  });
});
