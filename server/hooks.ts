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

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB

export interface BroadcastFns {
  broadcastEvent(sessionId: string, event: DbEvent): void;
  broadcastPermission(sessionId: string, permId: string, eventId: number, toolName: string, toolInput: unknown): void;
}

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
  // ── /session-start ───────────────────────────────────────────────────────
  app.post('/hooks/session-start', (req: Request, res: Response) => {
    const { session_id, cwd, model } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
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
    const { session_id, cwd, user_input, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'user_message', {
      message_text: user_input ?? null,
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      status: 'completed',
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /stop (assistant message) ────────────────────────────────────────────
  app.post('/hooks/stop', (req: Request, res: Response) => {
    const { session_id, cwd, assistant_message, stop_reason, agent_id, agent_type } = req.body as Record<
      string,
      string | undefined
    >;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    const eventId = insertEvent(session_id, 'assistant_message', {
      message_text: assistant_message ?? null,
      status: stop_reason ?? 'end_turn',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /pre-tool-use ────────────────────────────────────────────────────────
  app.post('/hooks/pre-tool-use', (req: Request, res: Response) => {
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

    let fileBefore: string | null = null;
    if (tool_name === 'Write' && tool_input && typeof tool_input.file_path === 'string') {
      fileBefore = snapshotFile(tool_input.file_path);
    }

    const eventId = insertEvent(session_id, 'tool_use', {
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      status: 'pending',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      file_before: fileBefore,
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /post-tool-use ───────────────────────────────────────────────────────
  app.post('/hooks/post-tool-use', (req: Request, res: Response) => {
    const { session_id, cwd, tool_name, tool_input, tool_response, agent_id, agent_type, pre_event_id } =
      req.body as {
        session_id?: string;
        cwd?: string;
        tool_name?: string;
        tool_input?: Record<string, unknown>;
        tool_response?: Record<string, unknown>;
        agent_id?: string;
        agent_type?: string;
        pre_event_id?: number;
      };
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);

    // Update pre-tool-use event to completed if we have it
    if (pre_event_id) {
      updateEvent(pre_event_id, {
        status: 'completed',
        tool_response: tool_response ? JSON.stringify(tool_response) : null,
      });
    }

    // Reconstruct file_before for Edit tool
    let fileBefore: string | null = null;
    if (
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
  app.post('/hooks/notification', (req: Request, res: Response) => {
    const { session_id, cwd, message, agent_id, agent_type } = req.body as Record<string, string | undefined>;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
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
