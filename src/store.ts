import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';

export type SessionStatus = 'idle' | 'running' | 'blocked' | 'failed';
export type TaskStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface FactorySession {
  id: string;
  chatId: string;
  title: string;
  agentInstanceId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryTask {
  id: string;
  sessionId: string;
  submissionId: string;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resultText: string | null;
  notifiedAt: string | null;
}

export interface Approval {
  id: string;
  sessionId: string;
  chatId: string;
  kind: 'infrastructure' | 'promotion';
  summary: string;
  command: string;
  risk: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export async function migrateApplicationTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_sessions (
      id uuid PRIMARY KEY,
      chat_id bigint NOT NULL,
      title text NOT NULL,
      agent_instance_id text NOT NULL UNIQUE,
      source_update_id bigint,
      status text NOT NULL CHECK (status IN ('idle', 'running', 'blocked', 'failed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS factory_sessions_chat_updated_idx
      ON factory_sessions (chat_id, updated_at DESC);
    ALTER TABLE factory_sessions ADD COLUMN IF NOT EXISTS source_update_id bigint;
    CREATE UNIQUE INDEX IF NOT EXISTS factory_sessions_source_update_idx
      ON factory_sessions (source_update_id) WHERE source_update_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS factory_chat_state (
      chat_id bigint PRIMARY KEY,
      active_session_id uuid REFERENCES factory_sessions(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS factory_tasks (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES factory_sessions(id) ON DELETE CASCADE,
      submission_id text NOT NULL UNIQUE,
      prompt text NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      error text,
      result_text text,
      notified_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS factory_tasks_session_started_idx
      ON factory_tasks (session_id, started_at DESC);

    ALTER TABLE factory_tasks ADD COLUMN IF NOT EXISTS result_text text;
    ALTER TABLE factory_tasks ADD COLUMN IF NOT EXISTS notified_at timestamptz;

    CREATE TABLE IF NOT EXISTS factory_approvals (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES factory_sessions(id) ON DELETE CASCADE,
      chat_id bigint NOT NULL,
      kind text NOT NULL CHECK (kind IN ('infrastructure', 'promotion')),
      summary text NOT NULL,
      command text NOT NULL,
      risk text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      decided_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS factory_approvals_status_created_idx
      ON factory_approvals (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS factory_telegram_updates (
      update_id bigint PRIMARY KEY,
      received_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    ALTER TABLE factory_telegram_updates ADD COLUMN IF NOT EXISTS completed_at timestamptz;

    DELETE FROM factory_telegram_updates
      WHERE completed_at IS NOT NULL AND completed_at < now() - interval '30 days';
  `);
}

export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO factory_telegram_updates (update_id) VALUES ($1)
     ON CONFLICT (update_id) DO UPDATE SET received_at = now()
       WHERE factory_telegram_updates.completed_at IS NULL
         AND factory_telegram_updates.received_at < now() - interval '5 minutes'
     RETURNING update_id`,
    [updateId],
  );
  return result.rowCount === 1;
}

export async function completeTelegramUpdate(updateId: number): Promise<void> {
  await pool.query(
    'UPDATE factory_telegram_updates SET completed_at = now() WHERE update_id = $1',
    [updateId],
  );
}

export async function releaseTelegramUpdate(updateId: number): Promise<void> {
  await pool.query(
    `UPDATE factory_telegram_updates SET received_at = '-infinity' WHERE update_id = $1 AND completed_at IS NULL`,
    [updateId],
  );
}

function mapSession(row: Record<string, unknown>): FactorySession {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    title: String(row.title),
    agentInstanceId: String(row.agent_instance_id),
    status: row.status as SessionStatus,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function mapTask(row: Record<string, unknown>): FactoryTask {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    submissionId: String(row.submission_id),
    prompt: String(row.prompt),
    status: row.status as TaskStatus,
    startedAt: new Date(row.started_at as string | Date).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string | Date).toISOString() : null,
    error: row.error === null ? null : String(row.error),
    resultText: row.result_text === null || row.result_text === undefined ? null : String(row.result_text),
    notifiedAt: row.notified_at ? new Date(row.notified_at as string | Date).toISOString() : null,
  };
}

function mapApproval(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    chatId: String(row.chat_id),
    kind: row.kind as Approval['kind'],
    summary: String(row.summary),
    command: String(row.command),
    risk: String(row.risk),
    status: row.status as ApprovalStatus,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at as string | Date).toISOString() : null,
  };
}

export async function createSession(chatId: string, title?: string, sourceUpdateId?: number): Promise<FactorySession> {
  const id = randomUUID();
  const short = id.slice(0, 8);
  const displayTitle = title?.trim() || `Session ${short}`;
  const agentInstanceId = `telegram-owner-${chatId}-${id}`;
  const result = await pool.query(
    `INSERT INTO factory_sessions (id, chat_id, title, agent_instance_id, source_update_id, status)
     VALUES ($1, $2, $3, $4, $5, 'idle')
     ON CONFLICT (source_update_id) WHERE source_update_id IS NOT NULL
     DO UPDATE SET source_update_id = EXCLUDED.source_update_id
     RETURNING *`,
    [id, chatId, displayTitle, agentInstanceId, sourceUpdateId ?? null],
  );
  await pool.query(
    `INSERT INTO factory_chat_state (chat_id, active_session_id)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET active_session_id = EXCLUDED.active_session_id, updated_at = now()`,
    [chatId, id],
  );
  return mapSession(result.rows[0] as Record<string, unknown>);
}

export async function getActiveSession(chatId: string): Promise<FactorySession | null> {
  const result = await pool.query(
    `SELECT s.* FROM factory_chat_state c
     JOIN factory_sessions s ON s.id = c.active_session_id
     WHERE c.chat_id = $1`,
    [chatId],
  );
  return result.rows[0] ? mapSession(result.rows[0] as Record<string, unknown>) : null;
}

export async function getSession(id: string): Promise<FactorySession | null> {
  const result = await pool.query('SELECT * FROM factory_sessions WHERE id = $1', [id]);
  return result.rows[0] ? mapSession(result.rows[0] as Record<string, unknown>) : null;
}

export async function switchSession(chatId: string, selector: string): Promise<FactorySession | null> {
  const result = await pool.query(
    `SELECT * FROM factory_sessions
     WHERE chat_id = $1 AND (id::text = $2 OR id::text LIKE $2 || '%')
     ORDER BY updated_at DESC LIMIT 1`,
    [chatId, selector],
  );
  if (!result.rows[0]) return null;
  const session = mapSession(result.rows[0] as Record<string, unknown>);
  await pool.query(
    `INSERT INTO factory_chat_state (chat_id, active_session_id)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET active_session_id = EXCLUDED.active_session_id, updated_at = now()`,
    [chatId, session.id],
  );
  return session;
}

export async function listSessions(chatId?: string, limit = 20): Promise<FactorySession[]> {
  const result = chatId
    ? await pool.query('SELECT * FROM factory_sessions WHERE chat_id = $1 ORDER BY updated_at DESC LIMIT $2', [chatId, limit])
    : await pool.query('SELECT * FROM factory_sessions ORDER BY updated_at DESC LIMIT $1', [limit]);
  return result.rows.map((row) => mapSession(row as Record<string, unknown>));
}

export async function setSessionStatus(id: string, status: SessionStatus): Promise<void> {
  await pool.query('UPDATE factory_sessions SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
}

export async function createTask(sessionId: string, submissionId: string, prompt: string): Promise<FactoryTask> {
  const result = await pool.query(
    `INSERT INTO factory_tasks (id, session_id, submission_id, prompt, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (submission_id) DO UPDATE SET submission_id = EXCLUDED.submission_id
     RETURNING *`,
    [randomUUID(), sessionId, submissionId, prompt],
  );
  const task = mapTask(result.rows[0] as Record<string, unknown>);
  if (task.status === 'running') await refreshSessionStatus(sessionId);
  return task;
}

export async function finishTask(
  submissionId: string,
  status: Exclude<TaskStatus, 'running'>,
  error?: string,
  resultText?: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE factory_tasks SET status = $2, error = $3, result_text = $4, finished_at = now()
     WHERE submission_id = $1 AND status = 'running' RETURNING session_id`,
    [submissionId, status, error ?? null, resultText ?? null],
  );
  const sessionId = result.rows[0]?.session_id as string | undefined;
  if (!sessionId) return;
  await pool.query(
    `UPDATE factory_sessions SET status = CASE
       WHEN EXISTS (
         SELECT 1 FROM factory_approvals
         WHERE session_id = $1 AND status = 'pending' AND expires_at > now()
       ) THEN 'blocked'
       WHEN EXISTS (
         SELECT 1 FROM factory_tasks WHERE session_id = $1 AND status = 'running'
       ) THEN 'running'
       WHEN $2 = 'failed' THEN 'failed'
       ELSE 'idle'
     END, updated_at = now()
     WHERE id = $1`,
    [sessionId, status],
  );
}

export async function latestRunningTask(sessionId: string): Promise<FactoryTask | null> {
  const result = await pool.query(
    `SELECT * FROM factory_tasks WHERE session_id = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ? mapTask(result.rows[0] as Record<string, unknown>) : null;
}

export async function listTasks(limit = 50): Promise<FactoryTask[]> {
  const result = await pool.query('SELECT * FROM factory_tasks ORDER BY started_at DESC LIMIT $1', [limit]);
  return result.rows.map((row) => mapTask(row as Record<string, unknown>));
}

export async function listRunningTasks(): Promise<FactoryTask[]> {
  const result = await pool.query("SELECT * FROM factory_tasks WHERE status = 'running' ORDER BY started_at ASC");
  return result.rows.map((row) => mapTask(row as Record<string, unknown>));
}

export async function listTasksAwaitingNotification(): Promise<FactoryTask[]> {
  const result = await pool.query(
    `SELECT * FROM factory_tasks
     WHERE status <> 'running' AND notified_at IS NULL AND result_text IS NOT NULL
     ORDER BY finished_at ASC`,
  );
  return result.rows.map((row) => mapTask(row as Record<string, unknown>));
}

export async function markTaskNotified(submissionId: string): Promise<void> {
  await pool.query(
    'UPDATE factory_tasks SET notified_at = now() WHERE submission_id = $1 AND notified_at IS NULL',
    [submissionId],
  );
}

export async function createApproval(input: {
  sessionId: string;
  chatId: string;
  kind: Approval['kind'];
  summary: string;
  command: string;
  risk: string;
  timeoutMinutes?: number;
}): Promise<Approval> {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO factory_approvals
       (id, session_id, chat_id, kind, summary, command, risk, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + ($8 * interval '1 minute'))
     RETURNING *`,
    [id, input.sessionId, input.chatId, input.kind, input.summary, input.command, input.risk, input.timeoutMinutes ?? 15],
  );
  await setSessionStatus(input.sessionId, 'blocked');
  return mapApproval(result.rows[0] as Record<string, unknown>);
}

export async function decideApproval(id: string, chatId: string, decision: 'approved' | 'rejected'): Promise<Approval | null> {
  const result = await pool.query(
    `UPDATE factory_approvals SET status = $3, decided_at = now()
     WHERE id = $1 AND chat_id = $2 AND status = 'pending' AND expires_at > now()
     RETURNING *`,
    [id, chatId, decision],
  );
  let row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    const existing = await pool.query(
      'SELECT * FROM factory_approvals WHERE id = $1 AND chat_id = $2 AND status = $3',
      [id, chatId, decision],
    );
    row = existing.rows[0] as Record<string, unknown> | undefined;
  }
  if (!row) return null;
  const approval = mapApproval(row);
  await refreshSessionStatus(approval.sessionId);
  return approval;
}

export async function getApproval(id: string): Promise<Approval | null> {
  const expired = await pool.query(
    `UPDATE factory_approvals SET status = 'expired', decided_at = now()
     WHERE id = $1 AND status = 'pending' AND expires_at <= now()
     RETURNING session_id`,
    [id],
  );
  const sessionId = expired.rows[0]?.session_id as string | undefined;
  if (sessionId) await refreshSessionStatus(sessionId);
  const result = await pool.query('SELECT * FROM factory_approvals WHERE id = $1', [id]);
  return result.rows[0] ? mapApproval(result.rows[0] as Record<string, unknown>) : null;
}

export async function expireApproval(id: string): Promise<void> {
  const result = await pool.query(
    `UPDATE factory_approvals SET status = 'expired', decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING session_id`,
    [id],
  );
  const sessionId = result.rows[0]?.session_id as string | undefined;
  if (sessionId) await refreshSessionStatus(sessionId);
}

export async function expireStaleApprovals(): Promise<number> {
  const result = await pool.query(
    `UPDATE factory_approvals SET status = 'expired', decided_at = now()
     WHERE status = 'pending' AND expires_at <= now() RETURNING session_id`,
  );
  const sessionIds = new Set(result.rows.map((row) => String(row.session_id)));
  await Promise.all([...sessionIds].map((sessionId) => refreshSessionStatus(sessionId)));
  return result.rowCount ?? 0;
}

export async function reconcileSessionStatuses(): Promise<void> {
  await pool.query(
    `WITH desired AS (
       SELECT s.id, CASE
         WHEN EXISTS (
           SELECT 1 FROM factory_approvals a
           WHERE a.session_id = s.id AND a.status = 'pending' AND a.expires_at > now()
         ) THEN 'blocked'
         WHEN EXISTS (
           SELECT 1 FROM factory_tasks t WHERE t.session_id = s.id AND t.status = 'running'
         ) THEN 'running'
         WHEN (
           SELECT t.status FROM factory_tasks t
           WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1
         ) = 'failed' THEN 'failed'
         ELSE 'idle'
       END AS status
       FROM factory_sessions s
     )
     UPDATE factory_sessions s SET status = desired.status, updated_at = now()
     FROM desired
     WHERE s.id = desired.id AND s.status IS DISTINCT FROM desired.status`,
  );
}

export async function listApprovals(limit = 50): Promise<Approval[]> {
  await expireStaleApprovals();
  const result = await pool.query('SELECT * FROM factory_approvals ORDER BY created_at DESC LIMIT $1', [limit]);
  return result.rows.map((row) => mapApproval(row as Record<string, unknown>));
}

async function refreshSessionStatus(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE factory_sessions SET status = CASE
       WHEN EXISTS (
         SELECT 1 FROM factory_approvals
         WHERE session_id = $1 AND status = 'pending' AND expires_at > now()
       ) THEN 'blocked'
       WHEN EXISTS (
         SELECT 1 FROM factory_tasks WHERE session_id = $1 AND status = 'running'
       ) THEN 'running'
       WHEN (
         SELECT status FROM factory_tasks WHERE session_id = $1 ORDER BY started_at DESC LIMIT 1
       ) = 'failed' THEN 'failed'
       ELSE 'idle'
     END, updated_at = now()
     WHERE id = $1`,
    [sessionId],
  );
}
