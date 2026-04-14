import fs from 'fs';
import type { Express, Request, Response } from 'express';
import path from 'path';
import {
  createSession,
  endSession,
  getSession,
  getDb,
  insertEvent,
  getEvent,
  createPermissionRequest,
  switchDb,
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

const CONTEXT_LINES = 10;

/**
 * Build a context-only diff snippet for an Edit operation.
 * Instead of storing the whole file, we store just the lines around the edit.
 * Returns { before, after } snippets with CONTEXT_LINES of surrounding context,
 * or null if the file can't be read.
 */
function buildEditSnippet(
  filePath: string, oldString: string, newString: string, replaceAll?: boolean
): { before: string; after: string } | null {
  try {
    const current = fs.readFileSync(filePath, 'utf8');
    const lines = current.split('\n');

    if (replaceAll) {
      // For replace_all: reverse ALL occurrences to get the "before" file
      const beforeContent = current.split(newString).join(oldString);
      const beforeLines = beforeContent.split('\n');

      // Find all changed line ranges
      const changedLineNums = new Set<number>();
      for (let i = 0; i < Math.max(lines.length, beforeLines.length); i++) {
        if (lines[i] !== beforeLines[i]) changedLineNums.add(i);
      }
      if (changedLineNums.size === 0) return { before: oldString, after: newString };

      // Build context window around all changes
      const minLine = Math.max(0, Math.min(...changedLineNums) - CONTEXT_LINES);
      const maxLine = Math.min(Math.max(lines.length, beforeLines.length) - 1, Math.max(...changedLineNums) + CONTEXT_LINES);

      return {
        before: beforeLines.slice(minLine, maxLine + 1).join('\n'),
        after: lines.slice(minLine, maxLine + 1).join('\n'),
      };
    }

    // Single replacement: find where newString is in the current file
    const idx = current.indexOf(newString);
    if (idx === -1) {
      // Can't find the edit — fall back to just the strings
      return { before: oldString, after: newString };
    }

    // Find line number of the edit
    const editLineStart = current.slice(0, idx).split('\n').length - 1;
    const editLineEnd = editLineStart + newString.split('\n').length - 1;

    // Extract context window
    const startLine = Math.max(0, editLineStart - CONTEXT_LINES);
    const endLine = Math.min(lines.length - 1, editLineEnd + CONTEXT_LINES);

    const afterSnippet = lines.slice(startLine, endLine + 1).join('\n');

    // Reconstruct "before" snippet: replace newString with oldString in the window
    const beforeContent = current.slice(0, idx) + oldString + current.slice(idx + newString.length);
    const beforeLines = beforeContent.split('\n');
    const beforeSnippet = beforeLines.slice(startLine, endLine + (oldString.split('\n').length - newString.split('\n').length) + 1).join('\n');

    return { before: beforeSnippet, after: afterSnippet };
  } catch {
    return null;
  }
}

/**
 * Build a snippet for a Write operation.
 * For the "before" state, use the snapshot from PreToolUse (or empty for new files).
 * Only store up to a preview — full file available on demand via API.
 */
const MAX_WRITE_PREVIEW_LINES = 50;

function buildWriteSnippet(beforeContent: string | null, newContent: string): { before: string; after: string } {
  const before = beforeContent || '';
  const afterLines = newContent.split('\n');
  const beforeLines = before.split('\n');

  // If small enough, store the whole thing
  if (afterLines.length <= MAX_WRITE_PREVIEW_LINES && beforeLines.length <= MAX_WRITE_PREVIEW_LINES) {
    return { before, after: newContent };
  }

  // Otherwise store just the first N lines as preview
  return {
    before: beforeLines.slice(0, MAX_WRITE_PREVIEW_LINES).join('\n') + (beforeLines.length > MAX_WRITE_PREVIEW_LINES ? '\n... (truncated)' : ''),
    after: afterLines.slice(0, MAX_WRITE_PREVIEW_LINES).join('\n') + (afterLines.length > MAX_WRITE_PREVIEW_LINES ? '\n... (truncated)' : ''),
  };
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

      // Switch to per-session DB stored alongside Claude's session JSONL
      // Path: ~/.claude/projects/<project-dir>/<session-id>.webui.db
      if (cwd) {
        const homeDir = process.env.HOME || '/root';
        const projectDirName = cwd.replace(/\//g, '-');
        const sessionDbPath = path.join(homeDir, '.claude', 'projects', projectDirName, `${session_id}.webui.db`);
        try {
          fs.mkdirSync(path.dirname(sessionDbPath), { recursive: true });
          switchDb(sessionDbPath);
          if (DEBUG) console.log(`[hooks] Switched DB to: ${sessionDbPath}`);

          // If DB is empty, import history from Claude's JSONL transcript
          const eventCount = (getDb().prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;
          if (eventCount === 0) {
            const jsonlPath = path.join(path.dirname(sessionDbPath), `${session_id}.jsonl`);
            importFromJsonl(jsonlPath, session_id, cwd);
          }
        } catch (err) {
          console.error(`[hooks] Failed to switch DB: ${err}`);
        }
      }

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
  const pendingSnapshots = new Map<string, { fileBefore: string | null; sessionId: string; ts: number }>();

  // Periodically clean up entries older than 10 minutes to prevent unbounded growth
  const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const snapshotCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingSnapshots) {
      if (now - entry.ts > SNAPSHOT_TTL_MS) {
        pendingSnapshots.delete(key);
      }
    }
  }, 60_000); // run every 60 seconds
  snapshotCleanupTimer.unref?.(); // don't keep process alive

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

    // Store snapshot keyed by tool_use_id (or stable fallback key for Write tools)
    const key = tool_use_id ||
      (tool_name === 'Write' && tool_input && typeof tool_input.file_path === 'string'
        ? `${session_id}_Write_${tool_input.file_path}`
        : `${session_id}_${tool_name}_unknown`);
    pendingSnapshots.set(key, { fileBefore, sessionId: session_id, ts: Date.now() });

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

    // Build diff snippet for Edit/Write tools
    // Stored as JSON: {"before":"...","after":"..."} in file_before column
    let diffSnippet: string | null = null;

    if (tool_name === 'Edit' && tool_input &&
        typeof tool_input.file_path === 'string' &&
        typeof tool_input.old_string === 'string' &&
        typeof tool_input.new_string === 'string') {
      const snippet = buildEditSnippet(
        tool_input.file_path,
        tool_input.old_string,
        tool_input.new_string,
        !!tool_input.replace_all
      );
      if (snippet) diffSnippet = JSON.stringify(snippet);
    }

    if (tool_name === 'Write' && tool_input && typeof tool_input.content === 'string') {
      // Get the pre-write snapshot from PreToolUse
      let preContent: string | null = null;
      const writeKey = tool_use_id ||
        (typeof tool_input.file_path === 'string'
          ? `${session_id}_Write_${tool_input.file_path}`
          : null);
      if (writeKey && pendingSnapshots.has(writeKey)) {
        preContent = pendingSnapshots.get(writeKey)!.fileBefore;
        pendingSnapshots.delete(writeKey);
      }
      const snippet = buildWriteSnippet(preContent, tool_input.content);
      diffSnippet = JSON.stringify(snippet);
    }

    // Clean up snapshot entry even if not Write
    if (tool_use_id && pendingSnapshots.has(tool_use_id)) {
      pendingSnapshots.delete(tool_use_id);
    }

    const eventId = insertEvent(session_id, 'tool_result', {
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      tool_response: tool_response ? JSON.stringify(tool_response) : null,
      status: 'completed',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      file_before: diffSnippet,  // now stores {"before":"...","after":"..."} JSON
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

    // Check if we're in bypass/auto mode — auto-approve instead of waiting
    const { permission_mode } = req.body as { permission_mode?: string };
    const autoApprove = permission_mode === 'bypassPermissions' || permission_mode === 'auto';

    const eventId = insertEvent(session_id, 'permission_request', {
      tool_name: tool_name ?? null,
      tool_input: tool_input ? JSON.stringify(tool_input) : null,
      status: autoApprove ? 'completed' : 'pending',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
    });

    if (autoApprove) {
      // Don't create a blocking permission request — just log it as approved
      const event = getEvent(eventId)!;
      bc.broadcastEvent(session_id, event);
      res.json({ ok: true, event_id: eventId, autoApproved: true });
    } else {
      const permId = createPermissionRequest(eventId);
      bc.broadcastPermission(session_id, permId, eventId, tool_name ?? '', tool_input ?? {});
      const event = getEvent(eventId)!;
      bc.broadcastEvent(session_id, event);
      res.json({ id: permId, event_id: eventId });
    }
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

/**
 * Import conversation history from Claude's JSONL transcript into our web UI DB.
 * Called when switching to a session that has no webui.db yet.
 */
function importFromJsonl(jsonlPath: string, sessionId: string, cwd?: string): void {
  try {
    if (!fs.existsSync(jsonlPath)) return;
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    createSession(sessionId, undefined, cwd);
    let imported = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === 'user') {
          // Extract user message text
          let text = '';
          const msg = entry.message;
          if (msg && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text' && typeof part.text === 'string') {
                text = part.text;
              }
            }
          } else if (typeof msg?.content === 'string') {
            text = msg.content;
          }
          // Skip system noise
          if (!text || text.startsWith('<local-command') || text.startsWith('<system-reminder') || text.startsWith('<command-')) continue;
          insertEvent(sessionId, 'user_message', { message_text: text });
          imported++;
        }

        if (entry.type === 'assistant') {
          // Extract assistant message text
          const msg = entry.message;
          let text = '';
          if (msg && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text' && typeof part.text === 'string') {
                text += part.text;
              }
            }
          }
          if (text) {
            insertEvent(sessionId, 'assistant_message', {
              message_text: text,
              status: 'end_turn',
            });
            imported++;
          }

          // Extract tool uses from assistant message
          if (msg && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'tool_use') {
                insertEvent(sessionId, 'tool_result', {
                  tool_name: part.name || null,
                  tool_input: JSON.stringify(part.input || {}),
                  status: 'completed',
                });
                imported++;
              }
            }
          }
        }
      } catch { /* skip bad lines */ }
    }

    if (DEBUG) console.log(`[hooks] Imported ${imported} events from JSONL`);
  } catch (err) {
    console.error(`[hooks] Failed to import from JSONL: ${err}`);
  }
}
