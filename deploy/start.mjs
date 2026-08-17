import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const projectId = required('BWS_PROJECT_ID');
const bws = process.env.BWS_BINARY ?? '/opt/bws';
const raw = execFileSync(bws, ['secret', 'list', projectId, '--output', 'json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const entries = JSON.parse(raw);
const values = new Map(entries.map((entry) => [entry.key, entry.value]));

setSecret('TELEGRAM_BOT_TOKEN', required('BWS_TELEGRAM_SECRET_KEY'));
setSecret('MINIMAX_API_KEY', required('BWS_MINIMAX_SECRET_KEY'));
setSecret('DATABASE_URL', required('BWS_DATABASE_SECRET_KEY'));
setSecret('TELEGRAM_WEBHOOK_SECRET_TOKEN', required('BWS_TELEGRAM_WEBHOOK_SECRET_KEY'));

delete process.env.BWS_ACCESS_TOKEN;
verifyWorkspaceRuntime();
disableReplacedGateway();
const child = spawn(process.execPath, ['dist/server.mjs'], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

function setSecret(environmentName, key) {
  const value = values.get(key);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Bitwarden secret is missing: ${key}`);
  process.env[environmentName] = value;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function disableReplacedGateway() {
  if (process.env.TELEGRAM_MODE !== 'polling') return;
  const container = process.env.REPLACED_GATEWAY_CONTAINER;
  const profile = process.env.REPLACED_GATEWAY_PROFILE;
  if (!container || !profile) return;
  if (!/^[a-zA-Z0-9_.-]+$/.test(container) || !/^[a-zA-Z0-9_.-]+$/.test(profile)) {
    throw new Error('Invalid replacement gateway container or profile name');
  }
  const service = `/run/service/gateway-${profile}`;
  execFileSync('docker', [
    'exec', container, 'sh', '-c',
    'touch "$1/down" && /command/s6-svc -d "$1"',
    '--', service,
  ], { stdio: 'inherit' });
}

function verifyWorkspaceRuntime() {
  const image = process.env.WORKSPACE_IMAGE ?? 'flue-agent-workspace:local';
  execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  execFileSync('docker', ['info'], { stdio: 'ignore' });
  const stale = execFileSync('docker', ['ps', '-aq', '--filter', 'label=flue.agent.task=1'], { encoding: 'utf8' })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const container of stale) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
