import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startClaudeSession, stopClaudeSession, getSessionStatus } from './tmux.js';
import { getSession } from './db.js';
import { getManagedSessionId, setManagedSessionId, setWaitingForSessionStart } from './hooks.js';
import { resetQueue } from './queue.js';
import { broadcast } from './websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_SETTINGS_PATH = path.join(__dirname, '..', 'data', 'hooks-settings.json');

/** Check whether Claude Code has a JSONL transcript for this session/cwd.
 *  Without one, `claude --resume <id>` errors out and Claude exits. */
function jsonlExistsForSession(sessionId: string, cwd: string): boolean {
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

export type RestartOutcome = 'started' | 'cooldown' | 'no-session' | 'in-progress' | 'failed';

/** Resume Claude in the last-known cwd of the currently-managed session when
 *  the tmux session dies mid-operation. Rate-limited so we don't loop-restart
 *  a Claude that's crashing on startup.
 *
 *  Caller-friendly: returns a status so HTTP handlers can phrase their
 *  response accurately (e.g. "auto-restart on cooldown" vs. "restarting"). */
export async function autoRestartClaude(sidAtDeath: string | null): Promise<RestartOutcome> {
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

    return 'started';
  } catch (err) {
    console.error('[auto-restart] failed:', err);
    broadcast(sid, 'claude_dead', { reason: String(err) });
    return 'failed';
  } finally {
    restarting = false;
  }
}
