// Node's built-in SQLite (node:sqlite) — no native module to download or
// compile, so this works on offline / locked-down clusters where a prebuilt
// better-sqlite3 binary can't be fetched or built. API is a near drop-in:
// .prepare().run/get/all, {changes, lastInsertRowid}, named + positional params.
//
// Requires Node >= 22.13.0: node:sqlite landed in 22.5 but behind the
// --experimental-sqlite flag until 22.13 (and 23.4), so on 22.5–22.12 a bare
// require throws unless the flag is passed.
//
// Loaded via createRequire rather than a static `import ... from 'node:sqlite'`
// because vitest's bundled (older) module runner strips the `node:` prefix and
// fails to resolve the newer `node:sqlite` builtin. A runtime require sidesteps
// that static resolution; the tsx production runtime handles it either way.
import { createRequire } from 'node:module';
import { randomUUID } from 'crypto';
import type { DbSession, DbEvent, DbPermissionRequest, ReconnectSummary } from './types.js';

// Minimal structural type for the bits of node:sqlite we use. get()/all() return
// `unknown` (callers cast to a concrete row type, as they did with
// better-sqlite3), which keeps every existing cast at the call sites valid.
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
function loadDatabaseSync(): new (path: string) => SqliteDb {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch (err) {
    throw new Error(
      `Failed to load node:sqlite (needed for the database). It requires Node >= 22.13.0 ` +
      `(flag-free); you are on ${process.version}. Please upgrade Node. Original error: ${(err as Error).message}`
    );
  }
}
const DatabaseSyncCtor = loadDatabaseSync();

let db: SqliteDb | null = null;

export function initDb(dbPath = 'claude-web-ui.sqlite'): void {
  db = new DatabaseSyncCtor(dbPath);
  // node:sqlite has no .pragma() helper — issue it as SQL.
  db.exec('PRAGMA journal_mode = WAL');
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
      -- Millisecond precision so rows lex-sort against JSONL ms-precision
      -- timestamps inserted via the application code path. Bare INSERTs that
      -- omit timestamp still get the same shape.
      timestamp      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
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

export function getDb(): SqliteDb {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/** Close current DB and open a new one at a different path.
 *  Used when we learn the session ID and want to switch to the per-session DB. */
export function switchDb(newPath: string): void {
  if (db) db.close();
  initDb(newPath);
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
  /** Override the row's timestamp. Use when the event chronologically
   *  belongs at a different point than insertion time (e.g. JSONL-tail
   *  capture inserts intermediate text with the JSONL's timestamp so
   *  the events sort in chronological order even when inserted late). */
  timestamp?: string;
}

/** Format Date.now() into the same shape SQLite's `datetime('now')` produces
 *  but with millisecond precision so it sorts lex-correctly against ms-precision
 *  timestamps captured from the JSONL transcript. */
function nowMs(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
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
    timestamp = nowMs(),
  } = fields;

  const result = getDb().prepare(`
    INSERT INTO events
      (session_id, event_type, agent_id, agent_type, tool_name, tool_input,
       tool_response, message_text, status, file_before, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, eventType, agent_id, agent_type, tool_name, tool_input,
         tool_response, message_text, status, file_before, timestamp);

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

  // Pagination cursors: rows are sorted by (timestamp, id). The cursor
  // therefore needs BOTH coordinates — using just `id < ?` would skip rows
  // whose JSONL-late insertion landed with a higher id but earlier timestamp.
  // Look up the boundary row's timestamp and use a row-value comparison.
  if (before !== undefined) {
    const boundary = getDb().prepare('SELECT timestamp FROM events WHERE id = ?').get(before) as { timestamp: string } | undefined;
    if (boundary) {
      conditions.push('(timestamp, id) < (?, ?)');
      params.push(boundary.timestamp, before);
    } else {
      conditions.push('id < ?');
      params.push(before);
    }
  }
  if (afterId !== undefined) {
    const boundary = getDb().prepare('SELECT timestamp FROM events WHERE id = ?').get(afterId) as { timestamp: string } | undefined;
    if (boundary) {
      conditions.push('(timestamp, id) > (?, ?)');
      params.push(boundary.timestamp, afterId);
    } else {
      conditions.push('id > ?');
      params.push(afterId);
    }
  }

  // afterId: get events after a point, ascending (for WebSocket catch-up)
  // before: get N most recent events before a point (for scroll-up pagination)
  // neither: get the latest N events (for initial load)
  // In all cases, return in chronological order (oldest first).
  const wantLatest = before !== undefined || (afterId === undefined && limit !== undefined);
  const order = wantLatest ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY timestamp ${order}, id ${order}`;
  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  const results = getDb().prepare(sql).all(...params) as DbEvent[];
  return wantLatest ? results.reverse() : results;
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
  const behavior = decision === 'allow' ? 'allow' : 'deny';
  const responseJson = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior },
    },
  });
  getDb().prepare(
    `UPDATE permission_requests SET decision = ?, decided_at = datetime('now'), response_json = ? WHERE id = ?`
  ).run(decision, responseJson, id);
}

export function getReconnectSummary(sessionId: string, afterEventId: number): ReconnectSummary {
  const d = getDb();

  const totalRow = d.prepare(
    `SELECT COUNT(*) as cnt FROM events WHERE session_id = ? AND id > ?`
  ).get(sessionId, afterEventId) as { cnt: number };

  // Edits: tool_use/tool_result events where tool_name IN ('Edit', 'Write', 'MultiEdit')
  const editRows = d.prepare(`
    SELECT id, tool_input, tool_name, file_before
    FROM events
    WHERE session_id = ?
      AND id > ?
      AND event_type IN ('tool_use', 'tool_result')
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

  // Commands: Bash tool uses/results
  const commandRows = d.prepare(`
    SELECT id, tool_input, status
    FROM events
    WHERE session_id = ?
      AND id > ?
      AND event_type IN ('tool_use', 'tool_result')
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
      WHERE session_id = ? AND agent_id = ? AND event_type IN ('tool_use', 'tool_result')
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
