import fs from 'fs';
import type { Express, Request, Response } from 'express';
import {
  createSession,
  endSession,
  getSession,
  insertEvent,
  updateEvent,
  getEvent,
  createPermissionRequest,
} from './db.js';
import type { DbEvent } from './types.js';
import { startStreaming, stopStreaming } from './streaming.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB
const DEBUG = process.env.DEBUG_HOOKS === '1';

export interface BroadcastFns {
  broadcastEvent(sessionId: string, event: DbEvent): void;
  broadcastPermission(sessionId: string, permId: string, eventId: number, toolName: string, toolInput: unknown): void;
}

// Track the managed Claude session ID. Set on first SessionStart from the tmux Claude.
// When set, only events from this session are accepted; others are silently dropped.
let managedSessionId: string | null = null;
// In real mode, we wait for SessionStart before accepting any events.
// This prevents events from other Claude sessions leaking in during startup.
let waitingForSessionStart = false;

export function getManagedSessionId(): string | null { return managedSessionId; }
export function setManagedSessionId(id: string | null): void { managedSessionId = id; }
export function setWaitingForSessionStart(val: boolean): void { waitingForSessionStart = val; }

/** Ensure a session exists, creating one if needed. */
function ensureSession(sessionId: string, cwd?: string, model?: string): void {
  if (!getSession(sessionId)) {
    createSession(sessionId, model, cwd);
  }
}

/** Read a file and return its content if it exists and is < 1MB, otherwise null. */
function snapshotFile(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_SNAPSHOT_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reconstruct the "before" state of a file by reversing an Edit operation.
 * Reads current file content, then replaces new_string with old_string.
 */
function reconstructFileBefore(filePath: string, oldString: string, newString: string): string | null {
  try {
    const current = fs.readFileSync(filePath, 'utf8');
    // Reverse: replace newString back to oldString (first occurrence)
    const idx = current.indexOf(newString);
    if (idx === -1) return current; // can't reverse, return current as best effort
    return current.slice(0, idx) + oldString + current.slice(idx + newString.length);
  } catch {
    return null;
  }
}

export function registerHookRoutes(app: Express, bc: BroadcastFns): void {

  // Middleware: silently drop events from non-managed sessions
  app.use('/hooks', (req: Request, res: Response, next) => {
    const sessionId = req.body?.session_id;
    // session-start is handled specially (sets managedSessionId), let it through
    if (req.path === '/session-start') { next(); return; }
    // In real mode, drop everything until we've received SessionStart
    if (waitingForSessionStart) {
      res.json({ ok: true, ignored: true });
      return;
    }
    // If no managed session (mock mode), accept everything
    if (!managedSessionId) { next(); return; }
    // Filter: only accept events from the managed session
    if (sessionId && sessionId !== managedSessionId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    next();
  });

  // ── /session-start ───────────────────────────────────────────────────────
  app.post('/hooks/session-start', (req: Request, res: Response) => {
    const { session_id, cwd, model } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    // In real mode, the first SessionStart after server boot is the managed session.
    // If managedSessionId is already set and this is a different session, ignore.
    if (managedSessionId && session_id !== managedSessionId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    if (!managedSessionId) {
      managedSessionId = session_id;
      waitingForSessionStart = false;
      if (DEBUG) console.log(`[hooks] Managed session set to: ${session_id}`);
    }
    createSession(session_id, model, cwd);
    res.json({ ok: true });
  });

  // ── /session-end ─────────────────────────────────────────────────────────
  app.post('/hooks/session-end', (req: Request, res: Response) => {
    const { session_id, cwd } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    endSession(session_id);
    res.json({ ok: true });
  });

  // ── /user-prompt ─────────────────────────────────────────────────────────
  app.post('/hooks/user-prompt', (req: Request, res: Response) => {
    if (DEBUG) console.log('[hook:user-prompt]', JSON.stringify(req.body).slice(0, 500));
    const { session_id, cwd, user_input, prompt, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'user_message', {
      message_text: prompt ?? user_input ?? null,
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'completed',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    // Start streaming — poll tmux for partial output
    startStreaming(session_id);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /stop (assistant message) ────────────────────────────────────────────
  app.post('/hooks/stop', (req: Request, res: Response) => {
    if (DEBUG) console.log('[hook:stop]', JSON.stringify(req.body).slice(0, 500));
    const { session_id, cwd, assistant_message, last_assistant_message, stop_reason, agent_id, agent_type } = req.body as Record<
      string,
      string | undefined
    >;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    // Stop streaming — the final message is here
    stopStreaming();
    const eventId = insertEvent(session_id, 'assistant_message', {
      message_text: last_assistant_message ?? assistant_message ?? null,
      status: stop_reason ?? 'end_turn',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /pre-tool-use ────────────────────────────────────────────────────────
  // Don't create a DB event for PreToolUse — only snapshot files for later.
  // The tool_use_id links PreToolUse to PostToolUse.
  const pendingSnapshots = new Map<string, { fileBefore: string | null; sessionId: string }>();

  app.post('/hooks/pre-tool-use', (req: Request, res: Response) => {
    const { session_id, cwd, tool_name, tool_input, tool_use_id } = req.body as {
      session_id?: string;
      cwd?: string;
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      tool_use_id?: string;
    };
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    // Stop streaming when a tool starts
    stopStreaming();

    // Snapshot file before Write overwrites it
    let fileBefore: string | null = null;
    if (tool_name === 'Write' && tool_input && typeof tool_input.file_path === 'string') {
      fileBefore = snapshotFile(tool_input.file_path);
    }

    // Store snapshot keyed by tool_use_id (or fallback key)
    const key = tool_use_id || `${session_id}_${tool_name}_${Date.now()}`;
    pendingSnapshots.set(key, { fileBefore, sessionId: session_id });

    // Broadcast a lightweight "running" indicator (no DB event)
    bc.broadcastEvent(session_id, {
      id: -1, // sentinel: frontend should show as transient
      session_id,
      timestamp: new Date().toISOString(),
      event_type: 'tool_running',
      agent_id: null,
      agent_type: null,
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      tool_response: null,
      message_text: null,
      status: 'running',
      file_before: null,
    });

    res.json({ ok: true });
  });

  // ── /post-tool-use ───────────────────────────────────────────────────────
  app.post('/hooks/post-tool-use', (req: Request, res: Response) => {
    const { session_id, cwd, tool_name, tool_input, tool_response, agent_id, agent_type, tool_use_id } =
      req.body as {
        session_id?: string;
        cwd?: string;
        tool_name?: string;
        tool_input?: Record<string, unknown>;
        tool_response?: Record<string, unknown>;
        agent_id?: string;
        agent_type?: string;
        tool_use_id?: string;
      };
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);

    // Retrieve file snapshot from PreToolUse (for Write tool)
    let fileBefore: string | null = null;
    if (tool_use_id && pendingSnapshots.has(tool_use_id)) {
      fileBefore = pendingSnapshots.get(tool_use_id)!.fileBefore;
      pendingSnapshots.delete(tool_use_id);
    }

    // Reconstruct file_before for Edit tool
    if (
      !fileBefore &&
      tool_name === 'Edit' &&
      tool_input &&
      typeof tool_input.file_path === 'string' &&
      typeof tool_input.old_string === 'string' &&
      typeof tool_input.new_string === 'string'
    ) {
      fileBefore = reconstructFileBefore(tool_input.file_path, tool_input.old_string, tool_input.new_string);
    }

    const eventId = insertEvent(session_id, 'tool_result', {
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      tool_response: tool_response ? JSON.stringify(tool_response) : null,
      status: 'completed',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      file_before: fileBefore,
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /permission-request ──────────────────────────────────────────────────
  app.post('/hooks/permission-request', (req: Request, res: Response) => {
    const { session_id, cwd, tool_name, tool_input, agent_id, agent_type } = req.body as {
      session_id?: string;
      cwd?: string;
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      agent_id?: string;
      agent_type?: string;
    };
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);

    const eventId = insertEvent(session_id, 'permission_request', {
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      status: 'pending',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
    });

    const permId = createPermissionRequest(eventId);
    bc.broadcastPermission(session_id, permId, eventId, tool_name ?? '', tool_input ?? {});

    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ id: permId, event_id: eventId });
  });

  // ── /subagent-start ──────────────────────────────────────────────────────
  app.post('/hooks/subagent-start', (req: Request, res: Response) => {
    const { session_id, cwd, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'subagent_start', {
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'running',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /subagent-stop ───────────────────────────────────────────────────────
  app.post('/hooks/subagent-stop', (req: Request, res: Response) => {
    const { session_id, cwd, agent_id, agent_type, last_assistant_message } = req.body as Record<
      string,
      string | undefined
    >;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'subagent_stop', {
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      message_text: last_assistant_message ?? null,
      status: 'completed',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /task-created ────────────────────────────────────────────────────────
  app.post('/hooks/task-created', (req: Request, res: Response) => {
    const { session_id, cwd, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'task_created', {
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'pending',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /task-completed ──────────────────────────────────────────────────────
  app.post('/hooks/task-completed', (req: Request, res: Response) => {
    const { session_id, cwd, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'task_completed', {
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'completed',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /notification ────────────────────────────────────────────────────────
  // Skip noisy system notifications that don't add value to the timeline
  const IGNORED_NOTIFICATIONS = [
    'waiting for your input',
    'is ready',
  ];

  app.post('/hooks/notification', (req: Request, res: Response) => {
    const { session_id, cwd, message, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    const msgLower = (message || '').toLowerCase();
    if (IGNORED_NOTIFICATIONS.some(n => msgLower.includes(n))) {
      res.json({ ok: true, ignored: true });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'notification', {
      message_text: message ?? null,
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'completed',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });
}
