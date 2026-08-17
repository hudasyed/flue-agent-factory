import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const releaseScript = resolve('deploy/release.sh');

describe('Git release deployment', () => {
  it('activates exact commits and rolls back to the previous immutable release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flue-release-'));
    const source = join(root, 'source');
    const deployment = join(root, 'deployment');
    const health = join(root, 'health.json');
    await mkdir(join(source, 'deploy'), { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
    const installer = join(source, 'deploy', 'install.sh');
    await copyFile(releaseScript, join(source, 'deploy', 'release.sh'));
    await writeFile(installer, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'{"release":"%s"}\\n\' "$RELEASE_ID" > "$TEST_HEALTH_FILE"',
      '',
    ].join('\n'));
    await chmod(installer, 0o755);
    await writeFile(join(source, 'version.txt'), 'one\n');
    await execFileAsync('git', ['add', '.'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'release one'], { cwd: source });
    const { stdout: firstOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source });
    const first = firstOutput.trim();

    const environment = {
      ...process.env,
      FLUE_DEPLOYMENT_ROOT: deployment,
      FLUE_DEPLOY_LOCK_FILE: join(root, 'deploy.lock'),
      FLUE_DEPLOY_LOCK_HELD: '1',
      FLUE_GIT_URL: source,
      FLUE_GIT_REF: 'main',
      FLUE_HEALTH_URL: `file://${health}`,
      FLUE_KEEP_RELEASES: '0',
      FLUE_RELEASE_COMMAND_PATH: join(root, 'flue-agent-release'),
      TEST_HEALTH_FILE: health,
    };
    await execFileAsync(releaseScript, ['main'], { env: environment });
    expect(await readlink(join(deployment, 'current'))).toBe(join(deployment, 'releases', first));

    await writeFile(join(source, 'version.txt'), 'two\n');
    await execFileAsync('git', ['add', 'version.txt'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'release two'], { cwd: source });
    const { stdout: secondOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source });
    const second = secondOutput.trim();
    await execFileAsync(releaseScript, ['main'], { env: environment });
    expect(await readlink(join(deployment, 'current'))).toBe(join(deployment, 'releases', second));
    expect(await readlink(join(deployment, 'previous'))).toBe(join(deployment, 'releases', first));

    await execFileAsync(releaseScript, ['--rollback'], { env: environment });
    expect(await readlink(join(deployment, 'current'))).toBe(join(deployment, 'releases', first));
    expect(await readlink(join(deployment, 'previous'))).toBe(join(deployment, 'releases', second));

    await writeFile(installer, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'{"release":"wrong-release"}\\n\' > "$TEST_HEALTH_FILE"',
      '',
    ].join('\n'));
    await execFileAsync('git', ['add', 'deploy/install.sh'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'broken release identity'], { cwd: source });
    await expect(execFileAsync(releaseScript, ['main'], { env: environment })).rejects.toMatchObject({ code: 1 });
    expect(await readlink(join(deployment, 'current'))).toBe(join(deployment, 'releases', first));
    expect(JSON.parse(await readFile(health, 'utf8')).release).toBe(first);

    const records = (await readFile(join(deployment, 'state', 'deployments.jsonl'), 'utf8')).trim().split('\n');
    expect(records.map((record) => JSON.parse(record).status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'failed',
    ]);
  });
});
