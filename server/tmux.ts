import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// These values are interpolated directly into shell commands, so reject
// anything outside a safe charset at module load.
function validateTmuxName(name: string, varName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid ${varName}: must match [A-Za-z0-9_-]+`);
  }
  return name;
}
export const TMUX_SESSION = validateTmuxName(process.env.CLAUDE_TMUX_SESSION || 'claude', 'CLAUDE_TMUX_SESSION');
export const TMUX_PANE = validateTmuxName(process.env.CLAUDE_TMUX_PANE || '0', 'CLAUDE_TMUX_PANE');
// Use a dedicated tmux socket so the session is invisible to `tmux ls`
// and `tmux attach` from outside the web UI server.
export const TMUX_SOCKET = validateTmuxName(process.env.CLAUDE_TMUX_SOCKET || 'claude-webui', 'CLAUDE_TMUX_SOCKET');
export const TMUX = `tmux -L ${TMUX_SOCKET}`;
const execOpts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', timeout: 5000 };

let startupCheckInterval: ReturnType<typeof setInterval> | null = null;
let sendSeq = 0;

export function sendInput(text: string): void {
  // Always use bracketed paste (-p) so the TUI treats the content as literal
  // text, not individual key events. Without -p, characters like > or ? in
  // longer messages can be misinterpreted by Claude Code's Ink-based TUI.
  // After pasting, send Enter separately to submit.
  const tmpFile = path.join(os.tmpdir(), `claude-webui-input-${process.pid}-${sendSeq++}.tmp`);
  const bufName = 'webui-input';
  try {
    fs.writeFileSync(tmpFile, text);
    execSync(`${TMUX} load-buffer -b ${bufName} ${shellEscape(tmpFile)}`, execOpts);
    execSync(`${TMUX} paste-buffer -d -p -b ${bufName} -t ${TMUX_SESSION}:${TMUX_PANE}`, execOpts);
    // TUI needs a moment to process the bracketed paste before Enter can submit
    execSync(`sleep 0.15 && ${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`, execOpts);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export function getSessionStatus(): { alive: boolean; session: string } {
  try {
    execSync(`${TMUX} has-session -t ${TMUX_SESSION} 2>/dev/null`, execOpts);
    return { alive: true, session: TMUX_SESSION };
  } catch {
    return { alive: false, session: TMUX_SESSION };
  }
}

export function startClaudeSession(args: string = '', cwd?: string): void {
  // Validate args to prevent injection
  if (args && !/^[\w\s\-\.\/]+$/.test(args)) {
    throw new Error('Invalid characters in args');
  }
  const dir = cwd || process.cwd();
  // cd first so Claude Code sees the correct project directory for --resume
  const cmd = `${TMUX} new-session -d -s ${TMUX_SESSION} -c ${shellEscape(dir)} "cd ${shellEscape(dir)} && claude ${args}"`;
  execSync(cmd, execOpts);

  // Auto-accept startup prompts (trust, theme, etc.) by pressing Enter.
  // Only check the LAST few lines of the pane to avoid matching conversation history.
  if (startupCheckInterval) clearInterval(startupCheckInterval);
  let attempts = 0;
  startupCheckInterval = setInterval(() => {
    attempts++;
    if (attempts > 20) { clearInterval(startupCheckInterval!); startupCheckInterval = null; return; }
    try {
      const paneContent = execSync(
        `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -8`,
        execOpts
      );
      const lastLines = paneContent.trim();

      // Check if Claude's main input prompt is visible (bottom of screen)
      // The prompt looks like: ❯ \n followed by separator ──── and status line
      if (lastLines.includes('bypass permissions') || lastLines.includes('shift+tab to cycle')) {
        clearInterval(startupCheckInterval!);
        startupCheckInterval = null;
        console.log('Claude is ready');
        return;
      }

      // Startup dialogs that need Enter:
      if (lastLines.includes('Enter to confirm') ||
          lastLines.includes('trust this folder') ||
          lastLines.includes('Yes, I trust') ||
          lastLines.includes('Dark mode') ||
          lastLines.includes('Press Enter to continue')) {
        execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`, execOpts);
        console.log('Auto-accepted startup prompt');
      }
    } catch {
      // ignore — tmux might not be ready yet
    }
  }, 1000);
}

export function stopClaudeSession(): void {
  try {
    execSync(`${TMUX} kill-session -t ${TMUX_SESSION} 2>/dev/null`, execOpts);
  } catch {
    // already dead
  }
}

function shellEscape(str: string): string {
  // Escape for shell: wrap in single quotes, escape any single quotes within
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
