import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'http';

// Mock child_process so tmux calls don't hit the real tmux session during tests.
// getCurrentPermissionMode() in hooks.ts uses execSync; return a neutral status bar.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { initDb, closeDb, getSession, getEvents, getEvent, getPermissionRequest } from '../../server/db.js';
import { registerHookRoutes, setManagedSessionId } from '../../server/hooks.js';
import type { BroadcastFns } from '../../server/hooks.js';

function tmpDbPath() {
  return path.join(os.tmpdir(), `test-hooks-db-${randomUUID()}.sqlite`);
}

function startServer(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

describe('Hook Routes', () => {
  let dbPath: string;
  let app: Express;
  let port: number;
  let closeServer: () => Promise<void>;
  let broadcastEvent: ReturnType<typeof vi.fn>;
  let broadcastPermission: ReturnType<typeof vi.fn>;
  let bc: BroadcastFns;

  beforeEach(async () => {
    // Reset module-level managed session state between tests
    setManagedSessionId(null);

    dbPath = tmpDbPath();
    initDb(dbPath);

    broadcastEvent = vi.fn();
    broadcastPermission = vi.fn();
    bc = { broadcastEvent, broadcastPermission };

    app = express();
    app.use(express.json());
    registerHookRoutes(app, bc);

    const srv = await startServer(app);
    port = srv.port;
    closeServer = srv.close;
  });

  afterEach(async () => {
    await closeServer();
    closeDb();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function url(path: string) {
    return `http://127.0.0.1:${port}${path}`;
  }

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  // ── /session-start ────────────────────────────────────────────────────────

  describe('POST /hooks/session-start', () => {
    it('creates a session and returns ok', async () => {
      const sessionId = randomUUID();
      const { status, body } = await post('/hooks/session-start', {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/home/user/project',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const session = getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(sessionId);
    });

    it('returns 400 if session_id is missing', async () => {
      const { status } = await post('/hooks/session-start', { hook_event_name: 'SessionStart' });
      expect(status).toBe(400);
    });
  });

  // ── /session-end ─────────────────────────────────────────────────────────

  describe('POST /hooks/session-end', () => {
    it('ends a session', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/session-end', {
        session_id: sessionId,
        hook_event_name: 'SessionEnd',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      const session = getSession(sessionId);
      expect(session!.ended_at).not.toBeNull();
    });
  });

  // ── /user-prompt ──────────────────────────────────────────────────────────

  describe('POST /hooks/user-prompt', () => {
    it('stores user message as event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/user-prompt', {
        session_id: sessionId,
        hook_event_name: 'UserPrompt',
        user_input: 'Hello, Claude!',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.event_id).toBeDefined();

      const events = getEvents(sessionId);
      const userMsg = events.find((e) => e.event_type === 'user_message');
      expect(userMsg).toBeDefined();
      expect(userMsg!.message_text).toBe('Hello, Claude!');
    });

    it('broadcasts the event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      await post('/hooks/user-prompt', {
        session_id: sessionId,
        hook_event_name: 'UserPrompt',
        user_input: 'Test message',
      });
      expect(broadcastEvent).toHaveBeenCalledWith(sessionId, expect.objectContaining({ event_type: 'user_message' }));
    });

    it('auto-creates session if not found', async () => {
      const sessionId = randomUUID();
      const { status } = await post('/hooks/user-prompt', {
        session_id: sessionId,
        hook_event_name: 'UserPrompt',
        user_input: 'Test',
      });
      expect(status).toBe(200);
      expect(getSession(sessionId)).not.toBeNull();
    });
  });

  // ── /stop (assistant message) ─────────────────────────────────────────────

  describe('POST /hooks/stop', () => {
    it('stores assistant message as event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/stop', {
        session_id: sessionId,
        hook_event_name: 'Stop',
        stop_reason: 'end_turn',
        assistant_message: 'I am done.',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.event_id).toBeDefined();

      const events = getEvents(sessionId);
      const assistantMsg = events.find((e) => e.event_type === 'assistant_message');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.message_text).toBe('I am done.');
      expect(assistantMsg!.status).toBe('end_turn');
    });

    it('broadcasts the event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      await post('/hooks/stop', {
        session_id: sessionId,
        hook_event_name: 'Stop',
        stop_reason: 'end_turn',
        assistant_message: 'Done',
      });
      expect(broadcastEvent).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ event_type: 'assistant_message' }),
      );
    });
  });

  // ── /pre-tool-use ─────────────────────────────────────────────────────────

  describe('POST /hooks/pre-tool-use', () => {
    it('returns ok without creating a DB event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/pre-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.event_id).toBeUndefined();

      // No tool_use event should be created by pre-tool-use
      const events = getEvents(sessionId);
      const toolUse = events.find((e) => e.event_type === 'tool_use');
      expect(toolUse).toBeUndefined();
    });

    it('snapshots file content for Write tool and passes it to post-tool-use', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-snap-${randomUUID()}.txt`);
      fs.writeFileSync(tmpFile, 'original content');
      const toolUseId = randomUUID();

      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      await post('/hooks/pre-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: tmpFile, content: 'new content' },
        tool_use_id: toolUseId,
      });

      // Now overwrite the file and call post-tool-use
      fs.writeFileSync(tmpFile, 'new content');
      const { body: postBody } = await post('/hooks/post-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: tmpFile, content: 'new content' },
        tool_response: { success: true },
        tool_use_id: toolUseId,
      });

      const ev = getEvent(postBody.event_id);
      // file_before is now JSON: {"before":"original content","after":"new content"}
      expect(ev!.file_before).not.toBeNull();
      const snippet = JSON.parse(ev!.file_before!);
      expect(snippet.before).toBe('original content');
      expect(snippet.after).toBe('new content');

      fs.unlinkSync(tmpFile);
    });

    it('does not snapshot for Write if file does not exist', async () => {
      const toolUseId = randomUUID();
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      await post('/hooks/pre-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/nonexistent/file.txt', content: 'hello' },
        tool_use_id: toolUseId,
      });

      // file_before should be null when the file doesn't exist
      const { body: postBody } = await post('/hooks/post-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/nonexistent/file.txt', content: 'hello' },
        tool_response: { success: true },
        tool_use_id: toolUseId,
      });

      const ev = getEvent(postBody.event_id);
      // Even for nonexistent files, Write stores a snippet with empty "before"
      expect(ev!.file_before).not.toBeNull();
      const snippet = JSON.parse(ev!.file_before!);
      expect(snippet.before).toBe('');
      expect(snippet.after).toBe('hello');
    });
  });

  // ── /post-tool-use ────────────────────────────────────────────────────────

  describe('POST /hooks/post-tool-use', () => {
    it('stores tool result event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });

      // Pre-tool-use no longer creates a DB event, just call it for completeness
      await post('/hooks/pre-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      });

      const { status, body } = await post('/hooks/post-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_response: { output: 'hello\n', exit_code: 0 },
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.event_id).toBeDefined();

      const ev = getEvent(body.event_id);
      expect(ev!.event_type).toBe('tool_result');
      expect(ev!.status).toBe('completed');
      expect(ev!.tool_name).toBe('Bash');
    });

    it('reconstructs file_before for Edit tool via reverse-edit', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-edit-${randomUUID()}.ts`);
      // Current file content (after edit has been applied)
      fs.writeFileSync(tmpFile, 'function hello() {\n  return "world";\n}\n');

      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });

      const { body } = await post('/hooks/post-tool-use', {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: tmpFile,
          old_string: 'return "world";',
          new_string: 'return "world";\n}',
        },
        tool_response: { success: true },
      });

      expect(body.ok).toBe(true);
      const ev = getEvent(body.event_id);
      // file_before is now JSON snippet: {"before":"...","after":"..."}
      expect(ev!.file_before).not.toBeNull();
      const snippet = JSON.parse(ev!.file_before!);
      expect(snippet.before).toContain('return "world";');
      expect(snippet.after).toContain('return "world";');

      fs.unlinkSync(tmpFile);
    });
  });

  // ── /permission-request ───────────────────────────────────────────────────

  describe('POST /hooks/permission-request', () => {
    it('creates permission request, broadcasts, and returns id', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/permission-request', {
        session_id: sessionId,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      expect(status).toBe(200);
      expect(body.id).toBeDefined();
      expect(body.id).toMatch(/^perm_/);

      const perm = getPermissionRequest(body.id);
      expect(perm).not.toBeNull();
      expect(perm!.decision).toBe('pending');

      expect(broadcastPermission).toHaveBeenCalledWith(
        sessionId,
        body.id,
        expect.any(Number),
        'Bash',
        expect.objectContaining({ command: 'rm -rf /' }),
      );
    });
  });

  // ── /subagent-start ───────────────────────────────────────────────────────

  describe('POST /hooks/subagent-start', () => {
    it('stores subagent_start event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const agentId = randomUUID();
      const { status, body } = await post('/hooks/subagent-start', {
        session_id: sessionId,
        hook_event_name: 'SubagentStart',
        agent_id: agentId,
        agent_type: 'Task',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const events = getEvents(sessionId);
      const ev = events.find((e) => e.event_type === 'subagent_start');
      expect(ev).toBeDefined();
      expect(ev!.agent_id).toBe(agentId);
      expect(ev!.agent_type).toBe('Task');
    });
  });

  // ── /subagent-stop ────────────────────────────────────────────────────────

  describe('POST /hooks/subagent-stop', () => {
    it('stores subagent_stop event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const agentId = randomUUID();
      const { status, body } = await post('/hooks/subagent-stop', {
        session_id: sessionId,
        hook_event_name: 'SubagentStop',
        agent_id: agentId,
        agent_type: 'Task',
        last_assistant_message: 'All done!',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const events = getEvents(sessionId);
      const ev = events.find((e) => e.event_type === 'subagent_stop');
      expect(ev).toBeDefined();
      expect(ev!.agent_id).toBe(agentId);
      expect(ev!.message_text).toBe('All done!');
      expect(ev!.status).toBe('completed');
    });
  });

  // ── /task-created ─────────────────────────────────────────────────────────

  describe('POST /hooks/task-created', () => {
    it('stores task_created event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/task-created', {
        session_id: sessionId,
        hook_event_name: 'TaskCreated',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const events = getEvents(sessionId);
      expect(events.some((e) => e.event_type === 'task_created')).toBe(true);
    });
  });

  // ── /task-completed ───────────────────────────────────────────────────────

  describe('POST /hooks/task-completed', () => {
    it('stores task_completed event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/task-completed', {
        session_id: sessionId,
        hook_event_name: 'TaskCompleted',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const events = getEvents(sessionId);
      expect(events.some((e) => e.event_type === 'task_completed')).toBe(true);
    });
  });

  // ── /notification ─────────────────────────────────────────────────────────

  describe('POST /hooks/notification', () => {
    it('stores notification event', async () => {
      const sessionId = randomUUID();
      await post('/hooks/session-start', { session_id: sessionId, hook_event_name: 'SessionStart' });
      const { status, body } = await post('/hooks/notification', {
        session_id: sessionId,
        hook_event_name: 'Notification',
        message: 'Build succeeded!',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const events = getEvents(sessionId);
      const ev = events.find((e) => e.event_type === 'notification');
      expect(ev).toBeDefined();
      expect(ev!.message_text).toBe('Build succeeded!');
    });
  });
});
