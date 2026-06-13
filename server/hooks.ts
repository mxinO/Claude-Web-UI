import fs from 'fs';
import { execSync } from 'child_process';
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
import { broadcast } from './websocket.js';
import { addAllowedRoot } from './api.js';
import { setClaudeBusy, setSessionIdGetter } from './queue.js';
import { TMUX, TMUX_SESSION, TMUX_PANE, tmuxExecOpts } from './tmux.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB
const DEBUG = process.env.DEBUG_HOOKS === '1';

/** Strip system noise from user message text. Task notifications are replaced
 *  with a short "[Task finished]" note. Returns null if nothing meaningful remains. */
export function cleanUserMessage(text: string | null): string | null {
  if (!text) return null;
  let cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '[Task finished]')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned;
}

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
export function isWaitingForSessionStart(): boolean { return waitingForSessionStart; }
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

const CONTEXT_LINES = 20;

const HUNK_SEPARATOR = '\n~~~ ... ~~~\n';

/** Build hunk-based before/after snippets from two sets of lines.
 *  Groups changed lines within 2*CONTEXT_LINES into single hunks,
 *  each with CONTEXT_LINES of surrounding context.
 *  Returns null if there are no changes. */
function buildHunks(
  beforeLines: string[], afterLines: string[]
): { before: string; after: string } | null {
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const changedLineNums: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    if (beforeLines[i] !== afterLines[i]) changedLineNums.push(i);
  }
  if (changedLineNums.length === 0) return null;

  // Merge changed lines that are close together into hunks
  const hunks: Array<{ start: number; end: number }> = [];
  let hunkStart = changedLineNums[0];
  let hunkEnd = changedLineNums[0];
  for (let i = 1; i < changedLineNums.length; i++) {
    if (changedLineNums[i] - hunkEnd <= CONTEXT_LINES * 2) {
      hunkEnd = changedLineNums[i];
    } else {
      hunks.push({ start: hunkStart, end: hunkEnd });
      hunkStart = changedLineNums[i];
      hunkEnd = changedLineNums[i];
    }
  }
  hunks.push({ start: hunkStart, end: hunkEnd });

  // Build before/after strings with context around each hunk
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  for (const hunk of hunks) {
    const lo = Math.max(0, hunk.start - CONTEXT_LINES);
    const hi = Math.min(maxLen - 1, hunk.end + CONTEXT_LINES);
    beforeParts.push(beforeLines.slice(lo, hi + 1).join('\n'));
    afterParts.push(afterLines.slice(lo, hi + 1).join('\n'));
  }

  return {
    before: beforeParts.join(HUNK_SEPARATOR),
    after: afterParts.join(HUNK_SEPARATOR),
  };
}

/**
 * Build a context-only diff snippet for an Edit operation.
 * Uses the real before-snapshot (from PreToolUse) and the current file (post-edit).
 */
function buildEditSnippet(
  filePath: string, beforeContent: string | null
): { before: string; after: string } | null {
  try {
    const afterContent = fs.readFileSync(filePath, 'utf8');
    if (beforeContent === null) return { before: '', after: afterContent };
    return buildHunks(beforeContent.split('\n'), afterContent.split('\n'));
  } catch {
    return null;
  }
}

/**
 * Build a snippet for a Write operation.
 * For the "before" state, use the snapshot from PreToolUse (or empty for new files).
 */
const MAX_WRITE_PREVIEW_LINES = 500;

function buildWriteSnippet(beforeContent: string | null, newContent: string): { before: string; after: string } {
  // New file — just show the content (truncated if huge)
  if (!beforeContent) {
    const lines = newContent.split('\n');
    if (lines.length <= MAX_WRITE_PREVIEW_LINES) return { before: '', after: newContent };
    return {
      before: '',
      after: lines.slice(0, MAX_WRITE_PREVIEW_LINES).join('\n') + '\n... (truncated)',
    };
  }
  // Existing file overwrite — use hunk-based diff
  // Fallback (null = no changes): return empty strings instead of full file content
  return buildHunks(beforeContent.split('\n'), newContent.split('\n'))
    ?? { before: '', after: '' };
}

/** Read the current Claude permission mode from the tmux status bar. */
function getCurrentPermissionMode(): string | null {
  try {
    const capture = execSync(
      `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -3`,
      tmuxExecOpts(3000),
    );
    if (capture.includes('plan mode')) return 'plan';
    if (capture.includes('bypass permissions')) return 'bypassPermissions';
    if (capture.includes('auto-accept')) return 'auto';
    return 'default';
  } catch { return null; }
}

/**
 * Find the correct DB path for a session by searching existing files first.
 * This avoids encoding mismatches between our CWD encoding and Claude Code's.
 */
function findSessionDbPath(projectsDir: string, sessionId: string, cwd: string): string {
  const dbName = `${sessionId}.webui.db`;
  const jsonlName = `${sessionId}.jsonl`;

  try {
    const dirs = fs.readdirSync(projectsDir);

    // 1. Check if a webui.db already exists for this session
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, dbName);
      if (fs.existsSync(candidate)) return candidate;
    }

    // 2. Put it next to Claude's JSONL (matches their directory encoding)
    for (const dir of dirs) {
      const jsonl = path.join(projectsDir, dir, jsonlName);
      if (fs.existsSync(jsonl)) return path.join(projectsDir, dir, dbName);
    }
  } catch { /* projectsDir doesn't exist yet */ }

  // 3. Fallback: compute path from CWD
  const projectDirName = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(projectsDir, projectDirName, dbName);
}

// Per-session set of assistant entry UUIDs we've already inserted as events.
// Used by captureIntermediateText() to avoid double-inserting on repeated
// hook fires within a turn. Cleared when the managed session changes.
const processedAssistantUuids = new Map<string, Set<string>>();
// Per-session text inserted via the Stop fallback (no JSONL uuid yet).
// captureIntermediateText consults this so a delayed JSONL flush — which
// arrives during the next PreToolUse — doesn't double-insert the same text.
const fallbackInsertedText = new Map<string, string>();

/** Locate the JSONL transcript for a session. Hooks pass `transcript_path`
 *  in their payload (per docs); fall back to the same discovery logic
 *  findSessionDbPath uses, so this works even if the hook doesn't include it. */
function locateTranscript(sessionId: string, hintPath: string | undefined, cwd: string | undefined): string | null {
  if (hintPath && fs.existsSync(hintPath)) return hintPath;
  const home = process.env.HOME || '/root';
  const projectsDir = path.join(home, '.claude', 'projects');
  const jsonlName = `${sessionId}.jsonl`;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, dir, jsonlName);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* projectsDir missing */ }
  if (cwd) {
    const projectDirName = cwd.replace(/[^a-zA-Z0-9.]/g, '-');
    const p = path.join(projectsDir, projectDirName, jsonlName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function registerHookRoutes(app: Express, bc: BroadcastFns): void {
  // Wire up the session ID getter for queue.ts (breaks circular import)
  setSessionIdGetter(() => managedSessionId);

  /** Tail the JSONL transcript and persist any assistant text blocks we
   *  haven't yet captured. Claude Code emits one JSONL entry per part —
   *  text and tool_use are separate lines in chronological order — and
   *  there's no per-text-block hook, so the only way to recover the
   *  text Claude emits before/between tool calls is to read the JSONL
   *  ourselves. UUID dedup means calling this from multiple hooks
   *  (PreToolUse, PostToolUse, Stop) is safe.
   *  Returns the number of new events inserted. */
  function captureIntermediateText(sessionId: string, transcriptPath?: string, cwd?: string): number {
    if (!sessionId) return 0;
    const jsonlPath = locateTranscript(sessionId, transcriptPath, cwd);
    if (!jsonlPath) return 0;
    let content: string;
    try { content = fs.readFileSync(jsonlPath, 'utf-8'); }
    catch { return 0; }
    let seen = processedAssistantUuids.get(sessionId);
    if (!seen) { seen = new Set(); processedAssistantUuids.set(sessionId, seen); }
    let inserts = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const uuid = entry.uuid as string | undefined;
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      const msg = entry.message as Record<string, unknown> | undefined;
      const parts = msg?.content;
      if (!Array.isArray(parts)) continue;
      let text = '';
      for (const p of parts) {
        if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text') {
          const t = (p as Record<string, unknown>).text;
          if (typeof t === 'string') text += t;
        }
      }
      if (!text.trim()) continue;
      // Skip if the Stop fallback already inserted this exact text. The map
      // is cleared on match so a second occurrence of the same text in a
      // later turn would still be inserted normally.
      if (fallbackInsertedText.get(sessionId) === text) {
        fallbackInsertedText.delete(sessionId);
        continue;
      }
      // Sub-agent attribution: top-level `isSidechain` + an attached
      // session/agent identifier. Best-effort propagation.
      const agentId = (entry.agentId as string | undefined) ?? (entry.subagent_id as string | undefined) ?? null;
      const agentType = (entry.agentType as string | undefined) ?? (entry.subagent_type as string | undefined) ?? null;
      // `stop_reason: 'end_turn'` marks the FINAL text block of the turn;
      // anything else is mid-turn streaming text. Stable enum, not raw API
      // values, so the UI doesn't see surprises like `"tool_use"`.
      const isFinal = (msg?.stop_reason as string | undefined) === 'end_turn';
      // Use the JSONL entry's own timestamp so the row sorts in chronological
      // order — even when this insert lands AFTER a tool_result that
      // chronologically came later. Round-trip through Date so timezone
      // suffixes other than `Z` (`+00:00`, etc.) all normalize to UTC ms,
      // matching the shape `nowMs()` produces.
      const isoTs = entry.timestamp as string | undefined;
      let ts: string | undefined;
      if (isoTs) {
        const d = new Date(isoTs);
        if (!Number.isNaN(d.getTime())) ts = d.toISOString().replace('T', ' ').replace('Z', '');
      }
      const eventId = insertEvent(sessionId, 'assistant_message', {
        message_text: text,
        status: isFinal ? 'end_turn' : 'streaming',
        agent_id: agentId,
        agent_type: agentType,
        timestamp: ts,
      });
      const event = getEvent(eventId);
      if (event) bc.broadcastEvent(sessionId, event);
      inserts++;
    }
    return inserts;
  }

  // Middleware: silently drop events from non-managed sessions
  app.use('/hooks', (req: Request, res: Response, next) => {
    const sessionId = req.body?.session_id;
    const hookName = req.path.replace(/^\//, '');
    // session-start is handled specially (sets managedSessionId), let it through
    if (req.path === '/session-start') {
      console.log(`[hook] ${hookName} session=${sessionId}`);
      next(); return;
    }
    // In real mode, drop everything until we've received SessionStart
    if (waitingForSessionStart) {
      console.log(`[hook] DROPPED ${hookName} (waiting for SessionStart)`);
      res.json({ ok: true, ignored: true });
      return;
    }
    // If no managed session (mock mode), accept everything
    if (!managedSessionId) { next(); return; }
    // Filter: only accept events from the managed session
    if (sessionId && sessionId !== managedSessionId) {
      console.log(`[hook] DROPPED ${hookName} session=${sessionId} (managed=${managedSessionId})`);
      res.json({ ok: true, ignored: true });
      return;
    }
    if (hookName === 'stop' || hookName === 'user-prompt') {
      console.log(`[hook] ${hookName} session=${sessionId}`);
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
      // IMPORTANT: Claude Code's directory encoding differs from ours (it preserves
      // dots/underscores, we replace them with hyphens). To avoid creating duplicate
      // DBs, search for an existing DB or JSONL by session ID first.
      if (cwd) {
        const homeDir = process.env.HOME || '/root';
        const projectsDir = path.join(homeDir, '.claude', 'projects');
        const sessionDbPath = findSessionDbPath(projectsDir, session_id, cwd);
        try {
          fs.mkdirSync(path.dirname(sessionDbPath), { recursive: true });
          switchDb(sessionDbPath);
          if (DEBUG) console.log(`[hooks] Switched DB to: ${sessionDbPath}`);

          // Mark any stale pending permissions as allowed (from previous runs — Claude already proceeded)
          getDb().prepare(
            "UPDATE events SET status = 'allowed' WHERE event_type = 'permission_request' AND status = 'pending'"
          ).run();
          // Also resolve stale permission_requests
          const allowJson = JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
          });
          getDb().prepare(
            "UPDATE permission_requests SET decision = 'allow', decided_at = datetime('now'), response_json = ? WHERE decision = 'pending'"
          ).run(allowJson);

          // If DB has no events for this session, import from Claude's JSONL transcript.
          // Our DB has richer data (permissions, tool details) so don't overwrite it.
          const eventCount = (getDb().prepare(
            'SELECT COUNT(*) as cnt FROM events WHERE session_id = ?'
          ).get(session_id) as { cnt: number }).cnt;
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
    if (cwd) addAllowedRoot(cwd);
    // Pre-populate the assistant-UUID seen set with anything already in the
    // JSONL — those messages either came from importFromJsonl (above) or
    // belong to a resumed session whose events are already in our DB.
    // Without this, the first PreToolUse/PostToolUse would re-insert them.
    // Note: importFromJsonl merges all text parts of one assistant entry
    // into a single event, while the live capture below splits per-part.
    // This causes a cosmetic difference between resumed and freshly-created
    // sessions — older turns appear as one paragraph, new turns as one
    // event per text block. Acceptable; not worth a backfill migration.
    {
      const jsonlPath = locateTranscript(session_id, undefined, cwd);
      if (jsonlPath) {
        try {
          const seen = new Set<string>();
          for (const line of fs.readFileSync(jsonlPath, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'assistant' && typeof entry.uuid === 'string') seen.add(entry.uuid);
            } catch { /* skip bad line */ }
          }
          processedAssistantUuids.set(session_id, seen);
        } catch { /* JSONL not yet present */ }
      }
    }
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
    processedAssistantUuids.delete(session_id);
    fallbackInsertedText.delete(session_id);
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
    // Clear per-turn file snapshots for this session (new turn starting)
    for (const key of turnSnapshots.keys()) {
      if (key.startsWith(session_id + ':')) turnSnapshots.delete(key);
    }
    const rawText = prompt ?? user_input ?? null;
    const msgText = cleanUserMessage(rawText);

    // Pure system noise (system reminders etc.) — don't create a user event
    if (!msgText) {
      res.json({ ok: true, filtered: true });
      return;
    }

    // Check if send-input already created this user_message (optimistic insert).
    // Match by text + recency (within last 60s) to avoid duplicates.
    let eventId: number | null = null;
    if (msgText) {
      const existing = getDb().prepare(
        `SELECT id FROM events WHERE session_id = ? AND event_type = 'user_message'
         AND message_text = ? AND timestamp > datetime('now', '-60 seconds')
         ORDER BY id DESC LIMIT 1`
      ).get(session_id, msgText) as { id: number } | undefined;
      if (existing) eventId = existing.id;
    }

    if (!eventId) {
      eventId = insertEvent(session_id, 'user_message', {
        message_text: msgText,
        agent_id: agent_id ?? null,
        agent_type: agent_type ?? null,
        status: 'completed',
      });
      const event = getEvent(eventId)!;
      bc.broadcastEvent(session_id, event);
    }

    // Start streaming — poll tmux for partial output
    startStreaming(session_id);
    res.json({ ok: true, event_id: eventId });
  });

  // ── /stop (assistant message) ────────────────────────────────────────────
  app.post('/hooks/stop', (req: Request, res: Response) => {
    if (DEBUG) console.log('[hook:stop]', JSON.stringify(req.body).slice(0, 500));
    const { session_id, cwd, transcript_path, assistant_message, last_assistant_message, stop_reason } =
      req.body as Record<string, string | undefined>;
    const finalText = last_assistant_message ?? assistant_message;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    ensureSession(session_id, cwd);
    // Stop streaming — the final message is here
    stopStreaming();
    // Clear per-turn file snapshots for this session (turn is ending)
    for (const key of turnSnapshots.keys()) {
      if (key.startsWith(session_id + ':')) turnSnapshots.delete(key);
    }
    // Capture every assistant text block — including the final one — from
    // the JSONL transcript. UUID dedup keeps repeated per-tool calls cheap.
    captureIntermediateText(session_id, transcript_path, cwd);
    // Fallback for when the JSONL flush is racy: if the hook payload's
    // `last_assistant_message` doesn't match the latest event in DB,
    // insert it. captureIntermediateText's own text-equality check then
    // prevents the late JSONL flush from creating a duplicate.
    let fallbackEventId: number | undefined;
    if (finalText) {
      const lastRow = getDb().prepare(
        `SELECT message_text FROM events WHERE session_id = ? AND event_type = 'assistant_message'
         ORDER BY id DESC LIMIT 1`
      ).get(session_id) as { message_text: string | null } | undefined;
      if (lastRow?.message_text !== finalText) {
        fallbackEventId = insertEvent(session_id, 'assistant_message', {
          message_text: finalText,
          status: 'end_turn',
        });
        const event = getEvent(fallbackEventId);
        if (event) bc.broadcastEvent(session_id, event);
        // Mark the text so a delayed JSONL flush in the next turn doesn't
        // re-insert this message via captureIntermediateText.
        fallbackInsertedText.set(session_id, finalText);
      }
    }
    // Claude finished this turn — mark idle (drains queue if messages pending)
    setClaudeBusy(false);
    // Definitive turn-end signal for the UI. stopStreaming() above only emits
    // streaming_done if the poll was active, and the final assistant_message
    // is only tagged 'end_turn' when the JSONL stop_reason is present (racy).
    // Broadcasting here unconditionally guarantees the client clears its
    // "working" indicators when the turn actually ends. Client handler is
    // idempotent.
    broadcast(session_id, 'streaming_done', {});
    res.json({ ok: true, event_id: fallbackEventId });
  });

  // ── /pre-tool-use ────────────────────────────────────────────────────────
  // Don't create a DB event for PreToolUse — only snapshot files for later.
  // The tool_use_id links PreToolUse to PostToolUse.
  const pendingSnapshots = new Map<string, { fileBefore: string | null; sessionId: string; ts: number }>();

  // Track first-edit snapshots per file per turn.
  // Key: "sessionId:filePath", Value: { content, ts }.
  // Cleared on stop/user-prompt (turn boundary), with TTL-based safety net.
  // Only used for Edit (not Write) — a Write creates a new file baseline,
  // so subsequent Edits should snapshot the post-Write state.
  const turnSnapshots = new Map<string, { content: string | null; ts: number }>();

  // Periodically clean up entries older than 10 minutes to prevent unbounded growth
  const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const snapshotCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingSnapshots) {
      if (now - entry.ts > SNAPSHOT_TTL_MS) {
        pendingSnapshots.delete(key);
      }
    }
    // Also clean up stale turnSnapshots (safety net if stop/user-prompt hooks don't fire)
    for (const [key, entry] of turnSnapshots) {
      if (now - entry.ts > SNAPSHOT_TTL_MS) turnSnapshots.delete(key);
    }
  }, 60_000); // run every 60 seconds
  snapshotCleanupTimer.unref?.(); // don't keep process alive

  app.post('/hooks/pre-tool-use', (req: Request, res: Response) => {
    const { session_id, cwd, transcript_path, tool_name, tool_input, tool_use_id } = req.body as {
      session_id?: string;
      cwd?: string;
      transcript_path?: string;
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      tool_use_id?: string;
    };
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    // Pause streaming while the tool runs — post-tool-use resumes it. Pass
    // `quiet` so the UI keeps the preview card visible instead of flickering.
    stopStreaming({ quiet: true });
    // Capture any assistant text Claude emitted before this tool call.
    // Best-effort — if the JSONL hasn't flushed yet we'll catch it on the
    // next hook (PostToolUse or Stop). Each row carries its own JSONL
    // timestamp so the API sorts events chronologically regardless of
    // insertion order. ensureSession first to avoid FK violations.
    ensureSession(session_id, cwd);
    captureIntermediateText(session_id, transcript_path, cwd);

    // Snapshot file before Edit/Write overwrites it.
    // For Edit: only snapshot on the FIRST edit to a file this turn.
    // Subsequent edits reuse the original snapshot so we get a combined diff.
    let fileBefore: string | null = null;
    if ((tool_name === 'Write' || tool_name === 'Edit') && tool_input && typeof tool_input.file_path === 'string') {
      const fp = tool_input.file_path;
      const turnKey = `${session_id}:${fp}`;
      if (tool_name === 'Edit' && turnSnapshots.has(turnKey)) {
        // Reuse the original snapshot from the first edit this turn
        fileBefore = turnSnapshots.get(turnKey)!.content;
      } else {
        fileBefore = snapshotFile(fp);
        if (tool_name === 'Edit') {
          turnSnapshots.set(turnKey, { content: fileBefore, ts: Date.now() });
        }
      }
    }

    // Store snapshot keyed by tool_use_id (or stable fallback key for Edit/Write tools)
    const key = tool_use_id ||
      ((tool_name === 'Write' || tool_name === 'Edit') && tool_input && typeof tool_input.file_path === 'string'
        ? `${session_id}_${tool_name}_${tool_input.file_path}`
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
    const { session_id, cwd, transcript_path, tool_name, tool_input, tool_response, agent_id, agent_type, tool_use_id } =
      req.body as {
        session_id?: string;
        cwd?: string;
        transcript_path?: string;
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
    // Capture any intermediate text Claude emitted before this tool ran.
    // Each row is inserted with the JSONL entry's own timestamp, so event
    // ordering (sorted by timestamp at query time) stays correct even when
    // capture lands AFTER tool_result is recorded — no need to poll for
    // the OS-level flush, which can take seconds.
    captureIntermediateText(session_id, transcript_path, cwd);

    // Build diff snippet for Edit/Write tools
    // Stored as JSON: {"before":"...","after":"..."} in file_before column
    let diffSnippet: string | null = null;

    // Retrieve pre-tool snapshot (used by both Edit and Write)
    let preContent: string | null = null;
    const snapshotKey = tool_use_id ||
      ((tool_name === 'Write' || tool_name === 'Edit') && tool_input && typeof tool_input.file_path === 'string'
        ? `${session_id}_${tool_name}_${tool_input.file_path}`
        : `${session_id}_${tool_name}_unknown`);
    if (snapshotKey && pendingSnapshots.has(snapshotKey)) {
      preContent = pendingSnapshots.get(snapshotKey)!.fileBefore;
      pendingSnapshots.delete(snapshotKey);
    }

    if (tool_name === 'Edit' && tool_input && typeof tool_input.file_path === 'string') {
      const snippet = buildEditSnippet(tool_input.file_path, preContent);
      if (snippet) diffSnippet = JSON.stringify(snippet);
    }

    if (tool_name === 'Write' && tool_input && typeof tool_input.content === 'string') {
      const snippet = buildWriteSnippet(preContent, tool_input.content);
      diffSnippet = JSON.stringify(snippet);
    }

    // Clean up snapshot entry if still present
    if (tool_use_id && pendingSnapshots.has(tool_use_id)) {
      pendingSnapshots.delete(tool_use_id);
    }

    // Don't store tool_response for Read — it's just file content already on disk.
    // For Write, strip the 'content' field from tool_input — we have the diff in file_before.
    let storedInput = tool_input ? JSON.stringify(tool_input) : null;
    if (tool_name === 'Write' && tool_input) {
      const { content: _, ...rest } = tool_input;
      storedInput = JSON.stringify(rest);
    }

    const eventId = insertEvent(session_id, 'tool_result', {
      tool_name: tool_name ?? null,
      tool_input: storedInput,
      tool_response: tool_name === 'Read' ? null : (tool_response ? JSON.stringify(tool_response) : null),
      status: 'completed',
      agent_id: agent_id ?? null,
      agent_type: agent_type ?? null,
      file_before: diffSnippet,  // now stores {"before":"...","after":"..."} JSON
    });
    const event = getEvent(eventId)!;
    bc.broadcastEvent(session_id, event);
    // Tool call finished — drain queue (matches Claude's native behavior:
    // queued input is sent after any message or tool call completes)
    setClaudeBusy(false);
    // Resume streaming so the live preview updates while Claude continues
    // generating text after the tool call. Stopped in pre-tool-use, started
    // again here; Stop will stop it at end-of-turn.
    startStreaming(session_id);
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
    // AskUserQuestion is an interactive picker, not a yes/no permission — never
    // create a permission card for it (the question watcher surfaces it
    // instead). This guard only suppresses the CARD; what prevents Claude from
    // dismissing the native picker is the hook script's own early-exit (it no
    // longer POSTs for AskUserQuestion). An OLD hook script that still POSTs
    // would get no `id` here and fall back to allow — which would dismiss the
    // picker — so updating the hook script (relaunch Claude) is required for
    // the full fix.
    if (tool_name === 'AskUserQuestion') {
      res.json({ ok: true, ignored: true });
      return;
    }
    ensureSession(session_id, cwd);

    // Check if we're in bypass/auto mode — auto-approve instead of waiting.
    // Read mode from the tmux status bar since Claude Code doesn't send it in the hook payload.
    const permMode = getCurrentPermissionMode();
    const autoApprove = permMode === 'bypassPermissions' || permMode === 'auto';

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
          // Clean system noise (task notifications, system reminders, etc.)
          const cleaned = cleanUserMessage(text);
          if (!cleaned || cleaned.startsWith('<local-command') || cleaned.startsWith('<command-')) continue;
          insertEvent(sessionId, 'user_message', { message_text: cleaned });
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
