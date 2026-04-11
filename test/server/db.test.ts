import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  initDb,
  getDb,
  createSession,
  endSession,
  getSession,
  getLatestSession,
  listSessions,
  insertEvent,
  updateEvent,
  getEvents,
  getEvent,
  createPermissionRequest,
  getPermissionRequest,
  resolvePermission,
  getReconnectSummary,
  pruneOldEvents,
  closeDb,
} from '../../server/db.js';

function tmpDbPath() {
  return path.join(os.tmpdir(), `test-db-${randomUUID()}.sqlite`);
}

describe('Database Layer', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  // ── Session CRUD ──────────────────────────────────────────────────────────

  describe('Session CRUD', () => {
    it('creates a session and retrieves it', () => {
      const id = randomUUID();
      createSession(id, 'claude-3-opus', '/home/user/project');
      const session = getSession(id);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(id);
      expect(session!.model).toBe('claude-3-opus');
      expect(session!.cwd).toBe('/home/user/project');
      expect(session!.ended_at).toBeNull();
    });

    it('INSERT OR IGNORE: duplicate createSession does not throw', () => {
      const id = randomUUID();
      createSession(id, 'model-a');
      expect(() => createSession(id, 'model-b')).not.toThrow();
      const session = getSession(id);
      // first insert wins
      expect(session!.model).toBe('model-a');
    });

    it('ends a session', () => {
      const id = randomUUID();
      createSession(id);
      endSession(id);
      const session = getSession(id);
      expect(session!.ended_at).not.toBeNull();
    });

    it('listSessions returns all sessions', () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of ids) createSession(id);
      const sessions = listSessions();
      const returnedIds = sessions.map((s) => s.id);
      for (const id of ids) expect(returnedIds).toContain(id);
    });

    it('getLatestSession returns the most recently started session', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      createSession(id1);
      // tiny delay to ensure different started_at values (SQLite datetime precision)
      const db = getDb();
      db.prepare(`UPDATE sessions SET started_at = datetime('now', '-1 second') WHERE id = ?`).run(id1);
      createSession(id2);
      const latest = getLatestSession();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(id2);
    });

    it('getSession returns null for unknown id', () => {
      expect(getSession('nonexistent')).toBeNull();
    });
  });

  // ── Event insert / update / fetch ─────────────────────────────────────────

  describe('Events', () => {
    let sessionId: string;

    beforeEach(() => {
      sessionId = randomUUID();
      createSession(sessionId);
    });

    it('inserts an event and retrieves it', () => {
      const id = insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'pending' });
      const ev = getEvent(id);
      expect(ev).not.toBeNull();
      expect(ev!.session_id).toBe(sessionId);
      expect(ev!.event_type).toBe('tool_use');
      expect(ev!.tool_name).toBe('Bash');
      expect(ev!.status).toBe('pending');
    });

    it('inserts event with all optional fields', () => {
      const id = insertEvent(sessionId, 'tool_use', {
        agent_id: 'agent-1',
        agent_type: 'subagent',
        tool_name: 'Edit',
        tool_input: JSON.stringify({ path: '/foo.ts' }),
        tool_response: JSON.stringify({ success: true }),
        message_text: 'hello',
        status: 'completed',
        file_before: 'original content',
      });
      const ev = getEvent(id);
      expect(ev!.agent_id).toBe('agent-1');
      expect(ev!.tool_input).toBe(JSON.stringify({ path: '/foo.ts' }));
      expect(ev!.file_before).toBe('original content');
    });

    it('updates an event', () => {
      const id = insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'pending' });
      updateEvent(id, { status: 'completed', tool_response: JSON.stringify({ output: 'ok' }) });
      const ev = getEvent(id);
      expect(ev!.status).toBe('completed');
      expect(ev!.tool_response).toBe(JSON.stringify({ output: 'ok' }));
    });

    it('getEvents returns events for a session', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'completed' }));
      }
      const events = getEvents(sessionId, {});
      expect(events.length).toBe(5);
    });

    it('getEvents paginates with limit', () => {
      for (let i = 0; i < 10; i++) {
        insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'completed' });
      }
      const events = getEvents(sessionId, { limit: 3 });
      expect(events.length).toBe(3);
    });

    it('getEvents paginates with before (cursor)', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(insertEvent(sessionId, 'tool_use', { status: 'completed' }));
      }
      // before=ids[3] should return events with id < ids[3]
      const events = getEvents(sessionId, { before: ids[3] });
      expect(events.every((e) => e.id < ids[3])).toBe(true);
    });

    it('getEvents paginates with afterId', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(insertEvent(sessionId, 'tool_use', { status: 'completed' }));
      }
      const events = getEvents(sessionId, { afterId: ids[1] });
      expect(events.every((e) => e.id > ids[1])).toBe(true);
      expect(events.length).toBe(3);
    });

    it('getEvent returns null for unknown id', () => {
      expect(getEvent(999999)).toBeNull();
    });
  });

  // ── Permission requests ───────────────────────────────────────────────────

  describe('Permission Requests', () => {
    let sessionId: string;
    let eventId: number;

    beforeEach(() => {
      sessionId = randomUUID();
      createSession(sessionId);
      eventId = insertEvent(sessionId, 'permission_request', { tool_name: 'Bash', status: 'pending' });
    });

    it('creates a permission request with perm_ prefix', () => {
      const permId = createPermissionRequest(eventId);
      expect(permId).toMatch(/^perm_/);
    });

    it('retrieves a permission request', () => {
      const permId = createPermissionRequest(eventId);
      const perm = getPermissionRequest(permId);
      expect(perm).not.toBeNull();
      expect(perm!.event_id).toBe(eventId);
      expect(perm!.decision).toBe('pending');
      expect(perm!.decided_at).toBeNull();
    });

    it('resolves a permission request', () => {
      const permId = createPermissionRequest(eventId);
      resolvePermission(permId, 'allow');
      const perm = getPermissionRequest(permId);
      expect(perm!.decision).toBe('allow');
      expect(perm!.decided_at).not.toBeNull();
    });

    it('resolves with deny decision', () => {
      const permId = createPermissionRequest(eventId);
      resolvePermission(permId, 'deny');
      const perm = getPermissionRequest(permId);
      expect(perm!.decision).toBe('deny');
    });

    it('returns null for unknown permission request id', () => {
      expect(getPermissionRequest('perm_nonexistent')).toBeNull();
    });
  });

  // ── Reconnect summary ────────────────────────────────────────────────────

  describe('Reconnect Summary', () => {
    let sessionId: string;

    beforeEach(() => {
      sessionId = randomUUID();
      createSession(sessionId);
    });

    it('returns zero counts for empty session', () => {
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.total_events).toBe(0);
      expect(summary.edits).toHaveLength(0);
      expect(summary.commands).toHaveLength(0);
      expect(summary.agents).toHaveLength(0);
      expect(summary.tasks_completed).toBe(0);
      expect(summary.tasks_in_progress).toBe(0);
      expect(summary.last_message).toBeNull();
    });

    it('counts total events', () => {
      insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'completed' });
      insertEvent(sessionId, 'tool_use', { tool_name: 'Read', status: 'completed' });
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.total_events).toBe(2);
    });

    it('aggregates edit events', () => {
      insertEvent(sessionId, 'tool_use', {
        tool_name: 'Edit',
        tool_input: JSON.stringify({ file_path: '/foo.ts', old_string: 'x', new_string: 'xy' }),
        status: 'completed',
      });
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.edits.length).toBeGreaterThan(0);
      const edit = summary.edits[0];
      expect(edit.file_path).toBe('/foo.ts');
    });

    it('aggregates command events', () => {
      insertEvent(sessionId, 'tool_use', {
        tool_name: 'Bash',
        tool_input: JSON.stringify({ command: 'npm test' }),
        status: 'completed',
      });
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.commands.length).toBeGreaterThan(0);
      expect(summary.commands[0].command).toBe('npm test');
    });

    it('aggregates agent events', () => {
      insertEvent(sessionId, 'subagent_start', {
        agent_id: 'agent-abc',
        agent_type: 'Task',
        status: 'completed',
      });
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.agents.length).toBeGreaterThan(0);
      expect(summary.agents[0].agent_id).toBe('agent-abc');
    });

    it('respects afterEventId filter', () => {
      const id1 = insertEvent(sessionId, 'tool_use', { tool_name: 'Bash', status: 'completed' });
      insertEvent(sessionId, 'tool_use', { tool_name: 'Read', status: 'completed' });
      const summary = getReconnectSummary(sessionId, id1);
      // Only events after id1
      expect(summary.total_events).toBe(1);
    });

    it('captures last assistant message', () => {
      insertEvent(sessionId, 'assistant_message', { message_text: 'Hello world', status: 'completed' });
      insertEvent(sessionId, 'assistant_message', { message_text: 'Done!', status: 'completed' });
      const summary = getReconnectSummary(sessionId, 0);
      expect(summary.last_message).toBe('Done!');
    });
  });

  // ── pruneOldEvents ────────────────────────────────────────────────────────

  describe('pruneOldEvents', () => {
    it('deletes events older than maxAgeDays', () => {
      const sessionId = randomUUID();
      createSession(sessionId);
      // Insert an old event by directly manipulating timestamp
      const db = getDb();
      const eventId = insertEvent(sessionId, 'tool_use', { status: 'completed' });
      db.prepare(`UPDATE events SET timestamp = datetime('now', '-31 days') WHERE id = ?`).run(eventId);

      pruneOldEvents(30);
      expect(getEvent(eventId)).toBeNull();
    });

    it('keeps events within maxAgeDays', () => {
      const sessionId = randomUUID();
      createSession(sessionId);
      const eventId = insertEvent(sessionId, 'tool_use', { status: 'completed' });
      pruneOldEvents(30);
      expect(getEvent(eventId)).not.toBeNull();
    });

    it('removes orphaned sessions (no events left)', () => {
      const sessionId = randomUUID();
      createSession(sessionId);
      const db = getDb();
      const eventId = insertEvent(sessionId, 'tool_use', { status: 'completed' });
      db.prepare(`UPDATE events SET timestamp = datetime('now', '-31 days') WHERE id = ?`).run(eventId);
      db.prepare(`UPDATE sessions SET started_at = datetime('now', '-31 days') WHERE id = ?`).run(sessionId);

      pruneOldEvents(30);
      expect(getSession(sessionId)).toBeNull();
    });

    it('keeps sessions that still have recent events', () => {
      const sessionId = randomUUID();
      createSession(sessionId);
      const db = getDb();
      const oldId = insertEvent(sessionId, 'tool_use', { status: 'completed' });
      db.prepare(`UPDATE events SET timestamp = datetime('now', '-31 days') WHERE id = ?`).run(oldId);
      // Also add a recent event
      insertEvent(sessionId, 'tool_use', { status: 'completed' });

      pruneOldEvents(30);
      expect(getSession(sessionId)).not.toBeNull();
    });
  });
});
