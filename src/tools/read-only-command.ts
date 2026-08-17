const shellSyntax = /[\n\r;&|><`$(){}\[\]*?!'"\\]/;

export function assertReadOnlyCommand(command: string): void {
  if (!command.trim() || shellSyntax.test(command)) {
    throw new Error('Read-only inspection commands cannot contain shell syntax');
  }
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] === 'sudo') tokens.shift();
  const executable = tokens.shift()?.replace(/^.*\//, '');
  const simple = new Set([
    'cat', 'date', 'df', 'free', 'grep', 'head', 'hostname', 'id', 'jq', 'ls',
    'ps', 'readlink', 'stat', 'tail', 'uname', 'uptime', 'who', 'whoami',
  ]);
  if (executable && simple.has(executable)) return;

  const allowedSubcommands: Record<string, Set<string>> = {
    docker: new Set(['info', 'inspect', 'logs', 'ps', 'stats', 'version']),
    pct: new Set(['config', 'list', 'status']),
    qm: new Set(['config', 'list', 'status']),
    systemctl: new Set(['is-active', 'is-enabled', 'list-units', 'show', 'status']),
  };
  const subcommand = tokens[0] ?? '';
  if (executable && allowedSubcommands[executable]?.has(subcommand)) return;

  if (executable === 'ip' && isReadOnlyIp(tokens)) return;
  if (executable === 'journalctl' && isReadOnlyJournalctl(tokens)) return;
  if (executable === 'ss' && !tokens.some((token) => token === '-K' || token === '--kill')) return;
  throw new Error('Command is not within the read-only inspection allowlist');
}

function isReadOnlyIp(tokens: string[]): boolean {
  const words = tokens.filter((token) => !token.startsWith('-'));
  return ['address', 'addr', 'link', 'route', 'rule', 'neighbor', 'neighbour']
    .includes(words[0] ?? '')
    && (words[1] === undefined || words[1] === 'show' || words[1] === 'list');
}

function isReadOnlyJournalctl(tokens: string[]): boolean {
  const allowedOptions = new Set([
    '--after-cursor', '--boot', '--cursor', '--disk-usage', '--grep', '--identifier',
    '--lines', '--list-boots', '--no-pager', '--output', '--pager-end', '--priority',
    '--quiet', '--reverse', '--since', '--unit', '--until', '--utc', '--verify',
    '-b', '-e', '-n', '-o', '-p', '-q', '-r', '-t', '-u',
  ]);
  for (const token of tokens) {
    if (!token.startsWith('-')) continue;
    const option = token.split('=', 1)[0];
    if (!allowedOptions.has(option)) return false;
  }
  return true;
}
