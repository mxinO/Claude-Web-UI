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

  // Auto-accept startup prompts (trust, theme, etc.) by pressing Enter.
  // Only check the LAST few lines of the pane to avoid matching conversation history.
  let attempts = 0;
  const startupCheck = setInterval(() => {
    attempts++;
    if (attempts > 20) { clearInterval(startupCheck); return; }
    try {
      const paneContent = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -8`,
        execOpts
      );
      const lastLines = paneContent.trim();

      // Check if Claude's main input prompt is visible (bottom of screen)
      // The prompt looks like: ❯ \n followed by separator ──── and status line
      if (lastLines.includes('bypass permissions') || lastLines.includes('shift+tab to cycle')) {
        clearInterval(startupCheck);
        console.log('Claude is ready');
        return;
      }

      // Startup dialogs that need Enter:
      if (lastLines.includes('Enter to confirm') ||
          lastLines.includes('trust this folder') ||
          lastLines.includes('Yes, I trust') ||
          lastLines.includes('Dark mode') ||
          lastLines.includes('Press Enter to continue')) {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`, execOpts);
        console.log('Auto-accepted startup prompt');
      }
    } catch {
      // ignore — tmux might not be ready yet
    }
  }, 1000);
}

export function stopClaudeSession(): void {
  try {
    execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`, execOpts);
  } catch {
    // already dead
  }
}

function shellEscape(str: string): string {
  // Escape for shell: wrap in single quotes, escape any single quotes within
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
