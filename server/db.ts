import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { DbSession, DbEvent, DbPermissionRequest, ReconnectSummary } from './types.js';

let db: Database.Database | null = null;

export function initDb(dbPath = 'claude-web-ui.sqlite'): void {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT,
      model       TEXT,
      cwd         TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL REFERENCES sessions(id),
      timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
      event_type     TEXT NOT NULL,
      agent_id       TEXT,
      agent_type     TEXT,
      tool_name      TEXT,
      tool_input     TEXT,
      tool_response  TEXT,
      message_text   TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      file_before    TEXT
    );

    CREATE TABLE IF NOT EXISTS permission_requests (
      id           TEXT PRIMARY KEY,
      event_id     INTEGER NOT NULL REFERENCES events(id),
      decision     TEXT NOT NULL DEFAULT 'pending',
      decided_at   TEXT,
      response_json TEXT
    );
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function createSession(id: string, model?: string, cwd?: string): void {
  const d = getDb();
  d.prepare(
    `INSERT OR IGNORE INTO sessions (id, model, cwd) VALUES (?, ?, ?)`
  ).run(id, model ?? null, cwd ?? null);
}

export function endSession(id: string): void {
  getDb().prepare(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run(id);
}

export function getSession(id: string): DbSession | null {
  return (getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as DbSession) ?? null;
}

export function getLatestSession(): DbSession | null {
  return (
    (getDb().prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as DbSession) ?? null
  );
}

export function listSessions(): DbSession[] {
  return getDb().prepare(`SELECT * FROM sessions ORDER BY started_at DESC`).all() as DbSession[];
}

interface EventFields {
  agent_id?: string | null;
  agent_type?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_response?: string | null;
  message_text?: string | null;
  status?: string;
  file_before?: string | null;
}

export function insertEvent(sessionId: string, eventType: string, fields: EventFields = {}): number {
  const {
    agent_id = null,
    agent_type = null,
    tool_name = null,
    tool_input = null,
    tool_response = null,
    message_text = null,
    status = 'pending',
    file_before = null,
  } = fields;

  const result = getDb().prepare(`
    INSERT INTO events
      (session_id, event_type, agent_id, agent_type, tool_name, tool_input,
       tool_response, message_text, status, file_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, eventType, agent_id, agent_type, tool_name, tool_input,
         tool_response, message_text, status, file_before);

  return result.lastInsertRowid as number;
}

export function updateEvent(id: number, fields: Partial<EventFields>): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  getDb().prepare(`UPDATE events SET ${setClauses} WHERE id = ?`).run(...values, id);
}

interface GetEventsOptions {
  before?: number;
  limit?: number;
  afterId?: number;
}

export function getEvents(sessionId: string, options: GetEventsOptions = {}): DbEvent[] {
  const { before, limit, afterId } = options;
  const conditions: string[] = ['session_id = ?'];
  const params: unknown[] = [sessionId];

  if (before !== undefined) {
    conditions.push('id < ?');
    params.push(before);
  }
  if (afterId !== undefined) {
    conditions.push('id > ?');
    params.push(afterId);
  }

  let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id ASC`;
  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  return getDb().prepare(sql).all(...params) as DbEvent[];
}

export function getEvent(id: number): DbEvent | null {
  return (getDb().prepare(`SELECT * FROM events WHERE id = ?`).get(id) as DbEvent) ?? null;
}

export function createPermissionRequest(eventId: number): string {
  const id = `perm_${randomUUID()}`;
  getDb().prepare(
    `INSERT INTO permission_requests (id, event_id) VALUES (?, ?)`
  ).run(id, eventId);
  return id;
}

export function getPermissionRequest(id: string): DbPermissionRequest | null {
  return (
    (getDb().prepare(`SELECT * FROM permission_requests WHERE id = ?`).get(id) as DbPermissionRequest) ?? null
  );
}

export function resolvePermission(id: string, decision: string): void {
  getDb().prepare(
    `UPDATE permission_requests SET decision = ?, decided_at = datetime('now') WHERE id = ?`
  ).run(decision, id);
}

export function getReconnectSummary(sessionId: string, afterEventId: number): ReconnectSummary {
  const d = getDb();

  const totalRow = d.prepare(
    `SELECT COUNT(*) as cnt FROM events WHERE session_id = ? AND id > ?`
  ).get(sessionId, afterEventId) as { cnt: number };

  // Edits: tool_use events where tool_name IN ('Edit', 'Write', 'MultiEdit')
  const editRows = d.prepare(`
    SELECT id, tool_input, tool_name, file_before
    FROM events
    WHERE session_id = ?
      AND id > ?
      AND event_type = 'tool_use'
      AND tool_name IN ('Edit', 'Write', 'MultiEdit')
  `).all(sessionId, afterEventId) as Array<{
    id: number;
    tool_input: string | null;
    tool_name: string;
    file_before: string | null;
  }>;

  const edits = editRows.map((row) => {
    let file_path = '';
    let additions = 0;
    let deletions = 0;
    let is_new = false;
    try {
      const input = JSON.parse(row.tool_input ?? '{}');
      file_path = input.file_path ?? input.path ?? '';
      if (row.tool_name === 'Write') {
        is_new = !row.file_before;
        const content: string = input.content ?? '';
        additions = content.split('\n').length;
      } else if (row.tool_name === 'Edit' || row.tool_name === 'MultiEdit') {
        const old_str: string = input.old_string ?? '';
        const new_str: string = input.new_string ?? '';
        deletions = old_str ? old_str.split('\n').length : 0;
        additions = new_str ? new_str.split('\n').length : 0;
      }
    } catch {
      // ignore parse errors
    }
    return { event_id: row.id, file_path, additions, deletions, is_new };
  });

  // Commands: Bash tool uses
  const commandRows = d.prepare(`
    SELECT id, tool_input, status
    FROM events
    WHERE session_id = ?
      AND id > ?
      AND event_type = 'tool_use'
      AND tool_name = 'Bash'
  `).all(sessionId, afterEventId) as Array<{
    id: number;
    tool_input: string | null;
    status: string;
  }>;

  const commands = commandRows.map((row) => {
    let command = '';
    try {
      const input = JSON.parse(row.tool_input ?? '{}');
      command = input.command ?? '';
    } catch {
      // ignore
    }
    return { event_id: row.id, command, status: row.status };
  });

  // Agents: subagent_start events, with tool_count and status
  const agentRows = d.prepare(`
    SELECT agent_id, agent_type, status
    FROM events
    WHERE session_id = ?
      AND id > ?
      AND event_type = 'subagent_start'
      AND agent_id IS NOT NULL
  `).all(sessionId, afterEventId) as Array<{
    agent_id: string;
    agent_type: string;
    status: string;
  }>;

  const agents = agentRows.map((row) => {
    const toolCountRow = d.prepare(`
      SELECT COUNT(*) as cnt FROM events
      WHERE session_id = ? AND agent_id = ? AND event_type = 'tool_use'
    `).get(sessionId, row.agent_id) as { cnt: number };
    return {
      agent_id: row.agent_id,
      agent_type: row.agent_type,
      tool_count: toolCountRow.cnt,
      status: row.status,
    };
  });

  // Tasks
  const tasksCompleted = (d.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE session_id = ? AND id > ? AND event_type = 'subagent_stop' AND status = 'completed'
  `).get(sessionId, afterEventId) as { cnt: number }).cnt;

  const tasksInProgress = (d.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE session_id = ? AND id > ? AND event_type = 'subagent_start'
      AND status != 'completed'
  `).get(sessionId, afterEventId) as { cnt: number }).cnt;

  // Last assistant message
  const lastMsgRow = d.prepare(`
    SELECT message_text FROM events
    WHERE session_id = ? AND id > ? AND event_type = 'assistant_message'
    ORDER BY id DESC LIMIT 1
  `).get(sessionId, afterEventId) as { message_text: string | null } | undefined;

  return {
    total_events: totalRow.cnt,
    edits,
    commands,
    agents,
    tasks_completed: tasksCompleted,
    tasks_in_progress: tasksInProgress,
    last_message: lastMsgRow?.message_text ?? null,
  };
}

export function pruneOldEvents(maxAgeDays = 30): void {
  const d = getDb();
  d.prepare(`
    DELETE FROM events
    WHERE timestamp < datetime('now', ? || ' days')
  `).run(`-${maxAgeDays}`);

  // Remove orphaned sessions that have no events and are older than maxAgeDays
  d.prepare(`
    DELETE FROM sessions
    WHERE started_at < datetime('now', ? || ' days')
      AND id NOT IN (SELECT DISTINCT session_id FROM events)
  `).run(`-${maxAgeDays}`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
