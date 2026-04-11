import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';

const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
const TMUX_PANE = process.env.CLAUDE_TMUX_PANE || '0';
const execOpts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', timeout: 5000 };

export function sendInput(text: string): void {
  // Send the text followed by Enter to Claude Code's TUI.
  // Note: -l (literal) mode doesn't work with Claude Code's input handler.
  // Instead, send the text as a single quoted argument + Enter.
  execSync(
    `tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} ${shellEscape(text)} Enter`,
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
  // Poll every second for up to 10 seconds, looking for the trust dialog.
  // When found, send Enter (option 1 "Yes, I trust this folder" is pre-selected).
  let attempts = 0;
  const trustCheck = setInterval(() => {
    attempts++;
    if (attempts > 10) { clearInterval(trustCheck); return; }
    try {
      const paneContent = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p`,
        execOpts
      );
      if (paneContent.includes('trust this folder') || paneContent.includes('Trust')) {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`, execOpts);
        console.log('Auto-accepted folder trust prompt');
        clearInterval(trustCheck);
      } else if (paneContent.includes('Claude Code')) {
        // Claude is already past the trust prompt
        clearInterval(trustCheck);
      }
    } catch {
      // ignore
    }
  }, 1000);
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
