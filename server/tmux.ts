import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';

const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
const TMUX_PANE = process.env.CLAUDE_TMUX_PANE || '0';
const execOpts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', timeout: 5000 };

export function sendInput(text: string): void {
  // Use tmux send-keys -l for literal mode (no escape interpretation)
  // We need to handle Enter separately since -l treats it literally
  execSync(
    `tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} -l ${shellEscape(text)}`,
    execOpts
  );
  // Send Enter key
  execSync(
    `tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`,
    execOpts
  );
}

export function getSessionStatus(): { alive: boolean; session: string } {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`, execOpts);
    return { alive: true, session: TMUX_SESSION };
  } catch {
    return { alive: false, session: TMUX_SESSION };
  }
}

export function startClaudeSession(args: string = '', cwd?: string): void {
  const dir = cwd || process.cwd();
  const cmd = `tmux new-session -d -s ${TMUX_SESSION} -c ${shellEscape(dir)} "claude ${args}"`;
  execSync(cmd, execOpts);

  // Auto-accept the "trust this folder" prompt if it appears.
  // Wait briefly for Claude to start, then send "y" + Enter.
  // If the prompt doesn't appear (already trusted), the "y" is harmless —
  // it just becomes the first user message, which we can live with.
  // A smarter approach: send "y" only if we detect the trust prompt.
  setTimeout(() => {
    try {
      // Capture the current pane content to check for trust prompt
      const paneContent = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p`,
        execOpts
      );
      if (paneContent.includes('trust') || paneContent.includes('Trust') || paneContent.includes('Do you want')) {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} y Enter`, execOpts);
        console.log('Auto-accepted folder trust prompt');
      }
    } catch {
      // tmux capture failed — ignore
    }
  }, 3000);
}

export function stopClaudeSession(): void {
  try {
    // Send /exit to Claude Code gracefully
    sendInput('/exit');
    // Give it a moment then kill if still alive
    setTimeout(() => {
      try {
        execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`, execOpts);
      } catch {
        // already dead
      }
    }, 3000);
  } catch {
    // session might already be dead
  }
}

function shellEscape(str: string): string {
  // Escape for shell: wrap in single quotes, escape any single quotes within
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
