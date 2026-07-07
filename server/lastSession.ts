import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TMUX_SOCKET } from './tmux.js';

// Persistent pointer to the most recently managed session, so a server restart
// can resume it instead of always starting fresh. Keyed by the tmux socket so
// multiple servers sharing this data dir (different ports) don't clobber each
// other's pointer.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', `last-session-${TMUX_SOCKET}.json`);

export interface LastSession { sessionId: string; cwd: string | null; }

/** Record the current managed session so a later restart can resume it. */
export function recordLastSession(sessionId: string, cwd: string | null): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ sessionId, cwd }));
  } catch { /* best-effort; resume is a convenience, not critical */ }
}

/** The last managed session, or null if none recorded / unreadable. */
export function readLastSession(): LastSession | null {
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (obj && typeof obj.sessionId === 'string') {
      return { sessionId: obj.sessionId, cwd: typeof obj.cwd === 'string' ? obj.cwd : null };
    }
  } catch { /* no file yet / bad json */ }
  return null;
}
