import { describe, expect, it } from 'vitest';
import { assertReadOnlyCommand } from '../src/tools/read-only-command.ts';

describe('read-only infrastructure commands', () => {
  it.each([
    'systemctl status docker',
    'docker inspect flue-agent-factory',
    'journalctl -u flue-agent-firewall --lines 100 --no-pager',
    'ip -brief address show',
    'sudo pct status 211',
  ])('allows inspection: %s', (command) => {
    expect(() => assertReadOnlyCommand(command)).not.toThrow();
  });

  it.each([
    'rm -rf /srv/flue-agent',
    'uptime\nreboot',
    'docker exec flue-agent-factory sh',
    'systemctl restart flue-agent-factory',
    'journalctl --vacuum-time=1s',
    'ip link set eth0 down',
    'ss --kill dst 192.0.2.1',
    'rg --pre rm pattern path',
    'git branch -D main',
  ])('rejects mutation: %s', (command) => {
    expect(() => assertReadOnlyCommand(command)).toThrow();
  });
});
