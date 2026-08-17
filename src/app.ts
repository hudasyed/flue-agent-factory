import { createAgentRouter } from '@flue/runtime/routing';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { Orchestrator } from './agents/orchestrator.ts';
import { channel as telegramChannel, resumePendingTelegramTasks } from './channels/telegram.ts';
import { pool } from './db.ts';
import { getOpenAIAuthState, logoutOpenAI, startOpenAIDeviceAuth } from './openai-auth.ts';
import {
  expireStaleApprovals,
  migrateApplicationTables,
  listApprovals,
  listSessions,
  listTasks,
  reconcileSessionStatuses,
} from './store.ts';
import { telegram } from './telegram-client.ts';
import { getTelegramPollingState, startTelegramPolling } from './telegram-polling.ts';
import { assertNoLegacyWorkspaceState } from './workspaces.ts';

await migrateApplicationTables();
await assertNoLegacyWorkspaceState();
await expireStaleApprovals();
await reconcileSessionStatuses();
await resumePendingTelegramTasks();

const approvalMaintenance = setInterval(() => {
  void expireStaleApprovals()
    .then(() => reconcileSessionStatuses())
    .catch((error) => console.error('[maintenance] state reconciliation failed', error));
}, 60_000);
approvalMaintenance.unref();

const telegramMode = parseTelegramMode(process.env.TELEGRAM_MODE);
if (telegramMode === 'polling') startTelegramPolling();

const app = new Hono();

const releaseId = process.env.RELEASE_ID ?? 'local';

app.get('/healthz', (context) => context.json({ ok: true, service: 'flue-agent-factory', release: releaseId }));
app.get('/readyz', async (context) => {
  try {
    await pool.query('SELECT 1');
    const polling = getTelegramPollingState();
    if (telegramMode === 'polling' && polling.status !== 'running') {
      return context.json({ ok: false, database: 'ready', telegram: polling }, 503);
    }
    return context.json({ ok: true, release: releaseId, database: 'ready', telegram: { mode: telegramMode, ...polling } });
  } catch (error) {
    return context.json({ ok: false, database: 'failed', error: error instanceof Error ? error.message : String(error) }, 503);
  }
});
// @flue/telegram and the app can resolve structurally-compatible Hono patch versions.
app.route('/channels/telegram', telegramChannel.route() as never);

app.use('/api/*', async (context, next) => {
  if (!isLanRequest(context)) return context.json({ error: 'LAN access only' }, 403);
  await next();
});

app.get('/api/status', async (context) => {
  const [sessions, tasks, approvals, openai, telegramInfo] = await Promise.all([
    listSessions(undefined, 30),
    listTasks(50),
    listApprovals(50),
    getOpenAIAuthState(),
    telegram.getWebhookInfo().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
  ]);
  return context.json({
    release: releaseId,
    sessions,
    tasks,
    approvals,
    openai,
    telegram: { mode: telegramMode, polling: getTelegramPollingState(), ...telegramInfo },
  });
});

app.post('/api/openai/device-auth', async (context) => context.json(startOpenAIDeviceAuth(), 202));
app.delete('/api/openai/auth', async (context) => {
  await logoutOpenAI();
  return context.json({ ok: true });
});

app.post('/api/telegram/webhook', async (context) => {
  if (telegramMode !== 'webhook') return context.json({ error: 'Set TELEGRAM_MODE=webhook before activating a webhook' }, 409);
  const url = process.env.PUBLIC_TELEGRAM_WEBHOOK_URL;
  if (!url) return context.json({ error: 'PUBLIC_TELEGRAM_WEBHOOK_URL is not configured' }, 409);
  await telegram.setWebhook(url, {
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
  });
  return context.json({ ok: true, url });
});

app.delete('/api/telegram/webhook', async (context) => {
  await telegram.deleteWebhook({ drop_pending_updates: false });
  return context.json({ ok: true });
});

// Kept available for LAN diagnostics and the internal UI; Telegram uses dispatch-only access.
app.route('/api/agents/orchestrator', createAgentRouter(Orchestrator));

app.get('/', (context) => {
  if (!isLanRequest(context)) return context.text('LAN access only', 403);
  return context.html(dashboardHtml());
});

export default app;

function parseTelegramMode(value: string | undefined): 'disabled' | 'polling' | 'webhook' {
  const mode = value ?? 'polling';
  if (mode === 'disabled' || mode === 'polling' || mode === 'webhook') return mode;
  throw new Error(`Invalid TELEGRAM_MODE: ${mode}`);
}

function isLanRequest(context: Context): boolean {
  if (process.env.ALLOW_NON_LAN_UI === '1') return true;
  const peer = normalizeAddress(getConnInfo(context).remote.address);
  if (!isLanAddress(peer)) return false;
  if (process.env.TRUST_LAN_PROXY === '1') {
    const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return isLanAddress(normalizeAddress(forwarded));
  }
  return true;
}

function normalizeAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

function isLanAddress(address: string): boolean {
  if (address === '127.0.0.1' || address === '::1') return true;
  const prefixes = (process.env.LAN_IPV4_PREFIXES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return prefixes.some((prefix) => address.startsWith(prefix));
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Flue Software Factory</title>
  <style>
    :root{color-scheme:dark;--bg:#0c1117;--panel:#141c25;--line:#263443;--text:#e6edf3;--muted:#8ca0b3;--good:#43d17a;--warn:#f1b84b;--bad:#ff6b6b;--accent:#6ea8fe}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{max-width:1200px;margin:0 auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 12px;color:#c8d6e5}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto}.wide{grid-column:1/-1}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.muted{color:var(--muted)}button{background:#233044;color:var(--text);border:1px solid #3b5068;border-radius:6px;padding:8px 11px;cursor:pointer}button.primary{background:#174b7a;border-color:#2879ba}button.danger{background:#5a2428;border-color:#8b3c42}.badge{padding:2px 7px;border-radius:999px;background:#263443}.connected,.completed,.approved,.idle{color:var(--good)}.running,.waiting,.pending,.blocked{color:var(--warn)}.failed,.rejected,.error{color:var(--bad)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}code{word-break:break-all}.auth-code{font-size:24px;letter-spacing:3px;color:var(--accent);margin:10px 0}@media(max-width:780px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.wrap{padding:16px}table{font-size:12px}}
  </style>
</head>
<body><div class="wrap">
  <header><div><h1>Flue Software Factory</h1><div class="muted">Orchestrator · private LAN control plane</div></div><button onclick="refresh()">Refresh</button></header>
  <div class="grid">
    <section class="panel"><h2>OpenAI subscription</h2><div id="openai">Loading…</div></section>
    <section class="panel"><h2>Telegram webhook</h2><div id="telegram">Loading…</div></section>
    <section class="panel wide"><h2>Sessions</h2><div id="sessions"></div></section>
    <section class="panel wide"><h2>Tasks</h2><div id="tasks"></div></section>
    <section class="panel wide"><h2>Approvals</h2><div id="approvals"></div></section>
  </div>
</div>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=s=>String(s??'').slice(0,8);
const badge=s=>'<span class="badge '+esc(s)+'">'+esc(s)+'</span>';
const table=(heads,rows)=>'<table><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>';
async function call(path,method='POST'){await fetch(path,{method});await refresh()}
async function refresh(){
 const r=await fetch('/api/status'); const d=await r.json();
 const a=d.openai;
 document.querySelector('#openai').innerHTML='<div>Status: '+badge(a.status)+'</div>'+
  (a.status==='waiting'?'<div class="auth-code">'+esc(a.userCode)+'</div><a target="_blank" href="'+esc(a.verificationUri)+'">Open authorization page</a>':'')+
  (a.error?'<p class="error">'+esc(a.error)+'</p>':'')+
  '<div class="row" style="margin-top:12px"><button class="primary" onclick="call(\'/api/openai/device-auth\')">Connect</button><button class="danger" onclick="call(\'/api/openai/auth\',\'DELETE\')">Disconnect</button></div>';
 const t=d.telegram;
 document.querySelector('#telegram').innerHTML=t.error?'<p class="error">'+esc(t.error)+'</p>':'<div>URL: <code>'+esc(t.url||'not configured')+'</code></div><div>Pending updates: '+esc(t.pending_update_count||0)+'</div><div class="row" style="margin-top:12px"><button class="primary" onclick="call(\'/api/telegram/webhook\')">Activate webhook</button><button class="danger" onclick="call(\'/api/telegram/webhook\',\'DELETE\')">Disable webhook</button></div>';
 document.querySelector('#sessions').innerHTML=table(['ID','Title','Status','Updated'],d.sessions.map(s=>'<tr><td><code>'+short(s.id)+'</code></td><td>'+esc(s.title)+'</td><td>'+badge(s.status)+'</td><td>'+esc(s.updatedAt)+'</td></tr>'));
 document.querySelector('#tasks').innerHTML=table(['Submission','Prompt','Status','Started','Error'],d.tasks.map(t=>'<tr><td><code>'+esc(t.submissionId.slice(-8))+'</code></td><td>'+esc(t.prompt.slice(0,160))+'</td><td>'+badge(t.status)+'</td><td>'+esc(t.startedAt)+'</td><td>'+esc(t.error||'')+'</td></tr>'));
 document.querySelector('#approvals').innerHTML=table(['Kind','Summary','Action','Status','Created'],d.approvals.map(a=>'<tr><td>'+esc(a.kind)+'</td><td>'+esc(a.summary)+'</td><td><code>'+esc(a.command)+'</code></td><td>'+badge(a.status)+'</td><td>'+esc(a.createdAt)+'</td></tr>'));
}
refresh(); setInterval(refresh,5000);
</script></body></html>`;
}
