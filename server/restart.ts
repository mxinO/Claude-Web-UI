import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startClaudeSession, stopClaudeSession, getSessionStatus, sendInput, isClaudeReady } from './tmux.js';
import { getSession } from './db.js';
import { getManagedSessionId, setManagedSessionId, setWaitingForSessionStart, isWaitingForSessionStart, setTurnActive, isTurnActive } from './hooks.js';
import { resetQueue } from './queue.js';
import { broadcast } from './websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_SETTINGS_PATH = path.join(__dirname, '..', 'data', 'hooks-settings.json');

/** Check whether Claude Code has a JSONL transcript for this session/cwd.
 *  Without one, `claude --resume <id>` errors out and Claude exits. */
export function jsonlExistsForSession(sessionId: string, cwd: string): boolean {
  const home = process.env.HOME || '/root';
  const projectsDir = path.join(home, '.claude', 'projects');
  // Claude Code encodes the cwd by replacing slashes (and other separators)
  // with hyphens but keeps dots — `/home/x/foo.bar` → `-home-x-foo.bar`.
  const encoded = cwd.replace(/[^a-zA-Z0-9.]/g, '-');
  const candidate = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return true;
  // Fallback: search all project dirs for the JSONL (handles encoding drift).
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      if (fs.existsSync(path.join(projectsDir, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch { /* projectsDir missing */ }
  return false;
}

const RESTART_COOLDOWN_MS = 30_000;
const HEALTH_CHECK_DELAY_MS = 5_000;
let restarting = false;
let lastRestartAt = 0;

/** True while an auto-restart is in progress (used by the health monitor to
 *  avoid re-triggering / logging during the restart's own kill→start window). */
export function isRestarting(): boolean { return restarting; }

// Set during server shutdown so an in-flight restart (parked in an await) does
// NOT spawn a fresh, detached tmux Claude that would outlive the process.
let shuttingDown = false;
export function setRestartShuttingDown(v: boolean): void { shuttingDown = v; }

export type RestartOutcome = 'started' | 'cooldown' | 'no-session' | 'in-progress' | 'failed';

/** Resume Claude in the last-known cwd of the currently-managed session when
 *  the tmux session dies mid-operation. Rate-limited so we don't loop-restart
 *  a Claude that's crashing on startup.
 *
 *  Caller-friendly: returns a status so HTTP handlers can phrase their
 *  response accurately (e.g. "auto-restart on cooldown" vs. "restarting"). */
export async function autoRestartClaude(sidAtDeath: string | null): Promise<RestartOutcome> {
  // A death mid-turn means no Stop hook will fire, so the server-authoritative
  // turn flag would stay true and /api/current-status would report busy:true to
  // any freshly-loaded tab forever. Clear it up front on every death path
  // (cooldown, no-session, started, failed) and tell live tabs to converge.
  if (isTurnActive()) {
    setTurnActive(false);
    const dsid = sidAtDeath || getManagedSessionId();
    if (dsid) broadcast(dsid, 'busy', { busy: false });
  }
  // Single-threaded JS: this check-then-set runs atomically before any await.
  if (restarting) return 'in-progress';
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    console.warn('[auto-restart] cooldown active — skipping');
    const sid = sidAtDeath || getManagedSessionId();
    if (sid) broadcast(sid, 'claude_dead', { reason: 'cooldown' });
    return 'cooldown';
  }
  // Set the cooldown timestamp BEFORE any awaits so a synchronous failure
  // doesn't let a tight retry loop bypass the rate limit.
  restarting = true;
  lastRestartAt = now;

  const sid = sidAtDeath || getManagedSessionId();
  if (!sid) {
    console.warn('[auto-restart] no managed session id — cannot resume');
    restarting = false;
    return 'no-session';
  }
  const sess = getSession(sid);
  const cwd = sess?.cwd || process.cwd();

  try {
    const canResume = jsonlExistsForSession(sid, cwd);
    console.log(`[auto-restart] ${canResume ? 'resuming' : 'starting fresh (no JSONL)'} in ${cwd}`);
    broadcast(sid, 'claude_restarting', { cwd, resume: canResume });

    stopClaudeSession();
    await new Promise(r => setTimeout(r, 500));
    // If the server began shutting down during that await, don't relaunch — a
    // fresh detached tmux Claude would outlive process.exit as an orphan.
    // (The finally below resets `restarting`.)
    if (shuttingDown) return 'in-progress';
    resetQueue();
    setManagedSessionId(null);
    setWaitingForSessionStart(true);

    const resumeArg = canResume ? ` --resume ${sid}` : '';
    startClaudeSession(`--settings ${HOOKS_SETTINGS_PATH}${resumeArg}`, cwd);
    console.log('[auto-restart] startClaudeSession invoked — waiting for SessionStart');

    // Health check: if Claude crashes deterministically on startup (e.g.
    // corrupted JSONL), the streaming detector won't notice until a turn
    // begins. Schedule a one-shot probe so we tell the UI right away.
    setTimeout(() => {
      if (!getSessionStatus().alive) {
        console.error('[auto-restart] Claude died again within ' + HEALTH_CHECK_DELAY_MS + 'ms');
        broadcast(sid, 'claude_dead', { reason: 'restart-failed' });
      }
    }, HEALTH_CHECK_DELAY_MS).unref?.();

    // On a resume, nudge Claude to pick up any interrupted work (a plain
    // --resume just reopens the transcript and waits). The prompt is written so
    // an idle session simply acknowledges — that's the only way to also cover
    // work the server can't see (scheduled wakeups / background tasks). A fresh
    // start has no transcript to resume, so skip it there.
    if (canResume) {
      void resumeInterruptedWork();
    }

    return 'started';
  } catch (err) {
    console.error('[auto-restart] failed:', err);
    broadcast(sid, 'claude_dead', { reason: String(err) });
    return 'failed';
  } finally {
    restarting = false;
  }
}

const RESUME_INTERRUPTED_MSG =
  '[system] This session was interrupted (the process was aborted) and has just been auto-resumed. ' +
  'If you had work in progress — an active task, background subagents/tasks, or a scheduled or looping action — ' +
  're-verify the current state and carefully resume it from where you left off, without repeating steps that already completed. ' +
  'If you were simply idle waiting for me, just briefly confirm you are back and wait for my next message.';

/** After a resume, wait for the TUI to reach its input prompt (past the
 *  bypass/trust startup dialogs) and inject a message telling Claude to pick up
 *  any interrupted work. Best-effort: gives up if it never becomes ready or the
 *  server is shutting down. */
let resumingWork = false;
async function resumeInterruptedWork(): Promise<void> {
  // Fire-and-forget + up-to-30s poll ≈ the restart cooldown, so a crash-loop
  // could otherwise overlap two of these and inject the prompt twice. Guard it.
  if (resumingWork) return;
  resumingWork = true;
  try {
    for (let i = 0; i < 60; i++) { // up to ~30s
      await new Promise(r => setTimeout(r, 500));
      if (shuttingDown) return;
      if (getManagedSessionId() && !isWaitingForSessionStart() && getSessionStatus().alive && isClaudeReady()) {
        sendInput(RESUME_INTERRUPTED_MSG);
        console.log('[auto-restart] resumed transcript — sent resume-work prompt');
        return;
      }
    }
    console.warn('[auto-restart] Claude did not become ready in time — skipped resume-work prompt');
  } finally {
    resumingWork = false;
  }
}
