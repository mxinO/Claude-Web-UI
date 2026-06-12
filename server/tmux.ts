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
// Pipe stderr so tmux errors (e.g. "no server running on ...") don't leak
// to our server stdout when the session dies. execSync throws on non-zero
// exit regardless, so callers still learn about failures via catch blocks.
const execOpts: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: 5000,
  stdio: ['pipe', 'pipe', 'pipe'],
};

/** Build execSync options for a tmux command with the stderr pipe baked in.
 *  Use this at every call site that runs `tmux …` so dead-session stderr
 *  ("no server running on …") doesn't leak to our stdout. */
export function tmuxExecOpts(timeout = 3000): ExecSyncOptionsWithStringEncoding {
  return { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] };
}

let startupCheckInterval: ReturnType<typeof setInterval> | null = null;
let sendSeq = 0;

// When true, every Claude session this server launches gets
// `--dangerously-skip-permissions`. Set once at startup from the --bypass CLI
// flag. Useful where an admin disables bypass mode in system config but the
// CLI arg is still honored. Applies to the initial session, auto-restart, and
// new/switch-session launches so the behavior is consistent.
let skipPermissions = false;
export function setSkipPermissions(v: boolean): void { skipPermissions = v; }
export function getSkipPermissions(): boolean { return skipPermissions; }

export function sendInput(text: string): void {
  // Claude Code's TUI debounces Enter for ~150-200ms after a bracketed paste
  // ends (anti-accidental-submit for multi-line pastes). We deliver the paste
  // synchronously, then schedule the Enter past the debounce as fire-and-forget
  // so the HTTP caller (and the WebSocket user_message broadcast) don't have
  // to wait the full ~260ms — only the paste's ~10ms.
  // Pasting via tmpfile + load-buffer (not send-keys -l) preserves special
  // characters like > / ? from being interpreted as TUI command triggers.
  const PASTE_BEGIN = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  const tmpFile = path.join(os.tmpdir(), `claude-webui-input-${process.pid}-${sendSeq++}.tmp`);
  const bufName = 'webui-input';
  fs.writeFileSync(tmpFile, PASTE_BEGIN + text + PASTE_END);
  execSync(`${TMUX} load-buffer -b ${bufName} ${shellEscape(tmpFile)}`, execOpts);
  execSync(`${TMUX} paste-buffer -d -b ${bufName} -t ${TMUX_SESSION}:${TMUX_PANE}`, execOpts);
  setTimeout(() => {
    try {
      execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Enter`, execOpts);
    } catch (err) {
      console.error('[sendInput] deferred Enter failed:', err);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }, 260);
}

/** Capture the pane iff Claude's native permission prompt is currently shown.
 *  In interactive mode (Claude Code 2.x) tool permissions are gated by a
 *  numbered TUI prompt, NOT the PermissionRequest hook — so the web UI must
 *  drive this prompt directly. The prompt looks like:
 *      Do you want to create foo.txt?
 *      ❯ 1. Yes
 *        2. Yes, allow all ... (shift+tab)
 *        3. No
 *      Esc to cancel · Tab to amend
 *  We require BOTH the question text AND the TUI selection caret on a numbered
 *  option (`❯ 1.`) — the mandatory caret keeps ordinary assistant prose that
 *  merely contains "Do you want to ... 1." from being mistaken for a prompt.
 *  Returns the pane text on match, else null. */
function capturePermissionPrompt(): string | null {
  try {
    const pane = execSync(
      `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -25`,
      tmuxExecOpts(3000),
    );
    if (/Do you want to /.test(pane) && /❯\s+\d+\.\s/.test(pane)) return pane;
    return null;
  } catch {
    return null;
  }
}

export function isPermissionPromptVisible(): boolean {
  return capturePermissionPrompt() !== null;
}

export interface QuestionOption { index: number; label: string; }
export interface QuestionPrompt { question: string; options: QuestionOption[]; }

/** Detect Claude's AskUserQuestion menu in the pane and parse it. It renders:
 *      ☐ Color
 *      Which color do you prefer?
 *      ❯ 1. Red
 *           A warm, bold color.
 *        2. Green
 *        ...
 *        5. Chat about this
 *      Enter to select · ↑/↓ to navigate · Esc to cancel
 *  Distinguished from the permission prompt by the "Enter to select" /
 *  "navigate" footer (permission uses "Do you want to" + "Tab to amend").
 *  Returns the question + numbered options, or null if no such menu. */
const OPTION_RE = /^\s*❯?\s*(\d+)\.\s+(.*\S)\s*$/;

export function detectQuestionPrompt(): QuestionPrompt | null {
  let pane: string;
  try {
    pane = execSync(
      `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -40`,
      tmuxExecOpts(3000),
    );
  } catch {
    return null;
  }
  return parseQuestionPane(pane);
}

/** Pure parser for the AskUserQuestion menu (separated from capture so it's
 *  unit-testable). Exported for tests. */
export function parseQuestionPane(pane: string): QuestionPrompt | null {
  if (!/Enter to select/i.test(pane) || !/to navigate/i.test(pane)) return null;

  const lines = pane.split('\n');
  // Anchor on the LAST "Enter to select" footer — the active menu sits just
  // above it. Scanning upward (rather than collecting every numbered line in
  // scrollback) avoids merging a previously-answered menu's options into this
  // one. Stop once we reach option "1." (menus always start at 1); anything
  // above that belongs to an earlier menu.
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Enter to select/i.test(lines[i])) { footerIdx = i; break; }
  }
  if (footerIdx === -1) return null;

  const collected: QuestionOption[] = [];
  let topOptionIdx = -1;
  for (let i = footerIdx - 1; i >= 0 && topOptionIdx === -1; i--) {
    const m = lines[i].match(OPTION_RE);
    if (m) {
      const index = parseInt(m[1], 10);
      collected.unshift({ index, label: m[2].trim() });
      if (index === 1) topOptionIdx = i; // top of the current menu
    }
    // non-option lines (descriptions, blanks, separators) are skipped
  }
  if (collected.length === 0 || topOptionIdx === -1) return null;

  // Question = nearest meaningful line above option 1 that isn't a separator,
  // a "☐ Header" chip, or another option line (which would be a prior menu).
  let question = '';
  for (let i = topOptionIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^[─━]{3,}$/.test(t)) continue;
    if (/^[☐☑▢◻]/.test(t)) continue;
    if (OPTION_RE.test(lines[i])) break; // hit the previous menu — no question here
    question = t;
    break;
  }
  return { question, options: collected };
}

/** Answer the AskUserQuestion menu by selecting option `index` (sends the
 *  literal digit, which selects + confirms). Validates that `index` is an
 *  option on the CURRENTLY-visible menu, so a stale click can't land on a
 *  different question. Single-digit options only (realistic menus have ≤9). */
export function respondToQuestion(index: number): boolean {
  if (!Number.isInteger(index) || index < 1 || index > 9) return false;
  const prompt = detectQuestionPrompt();
  if (!prompt || !prompt.options.some(o => o.index === index)) return false;
  try {
    execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} -l ${index}`, execOpts);
    return true;
  } catch (err) {
    console.error('[respondToQuestion] send-keys failed:', err);
    return false;
  }
}

/** Answer Claude's native permission prompt.
 *  allow → select option 1 ("Yes"); deny → Escape ("cancel").
 *  Returns true if a prompt was visible and a key was sent. Only acts when a
 *  prompt is actually showing, so a stray decision can't type into the input. */
export function respondToPermissionPrompt(allow: boolean): boolean {
  const pane = capturePermissionPrompt();
  if (!pane) return false;
  try {
    if (allow) {
      // Only auto-pick option 1 when it's the plain affirmative ("1. Yes").
      // Claude orders the single-allow as option 1 and "allow all"/"No" after;
      // refusing otherwise avoids silently granting a broader permission.
      if (!/(^|\s)1\.\s+Yes\b/im.test(pane)) {
        console.error('[respondToPermissionPrompt] option 1 is not a plain "Yes" — not auto-allowing');
        return false;
      }
      // `-l` sends the literal digit (never interpreted as a tmux key name).
      execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} -l 1`, execOpts);
    } else {
      // Escape triggers the prompt's own "Esc to cancel" → a clean rejection.
      execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Escape`, execOpts);
    }
    return true;
  } catch (err) {
    console.error('[respondToPermissionPrompt] send-keys failed:', err);
    return false;
  }
}

/** Read Claude's current permission mode from the TUI footer.
 *  Returns 'plan' | 'bypass' | 'acceptEdits' | 'auto' | 'default', or null if
 *  the pane couldn't be captured — so callers can distinguish a transient
 *  capture failure from a genuine 'default' and avoid downgrading the badge.
 *  Matching is substring-based (no required " on" suffix) to stay robust
 *  across Claude Code footer wording, matching hooks.ts getCurrentPermissionMode.
 *  `auto` is checked before `acceptEdits` so an "auto-accept edits" footer
 *  isn't misclassified. */
export function readPermissionMode(): string | null {
  let pane: string;
  try {
    pane = execSync(
      `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -3`,
      tmuxExecOpts(3000),
    );
  } catch {
    return null;
  }
  if (/plan mode/i.test(pane)) return 'plan';
  if (/bypass permissions/i.test(pane)) return 'bypass';
  if (/auto[- ]?accept|auto mode/i.test(pane)) return 'auto';
  if (/accept edits/i.test(pane)) return 'acceptEdits';
  return 'default';
}

/** Cycle Claude's permission mode by sending Shift+Tab (the TUI's own binding).
 *  Refuses when a native permission prompt is showing, because there Shift+Tab
 *  means "Yes, allow all" — we'd grant a broad permission by accident.
 *  Returns true if the keystroke was sent. The caller should read the settled
 *  mode after a short delay (the footer repaints asynchronously). */
export function cyclePermissionMode(): boolean {
  if (isPermissionPromptVisible()) return false;
  try {
    execSync(`${TMUX} send-keys -t ${TMUX_SESSION}:${TMUX_PANE} S-Tab`, execOpts);
    return true;
  } catch (err) {
    console.error('[cyclePermissionMode] send-keys failed:', err);
    return false;
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
  // --dangerously-skip-permissions bypasses all permission prompts via the CLI
  // arg (honored even where an admin disables bypass mode in settings).
  const bypassFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  // cd first so Claude Code sees the correct project directory for --resume
  const cmd = `${TMUX} new-session -d -s ${TMUX_SESSION} -c ${shellEscape(dir)} "cd ${shellEscape(dir)} && claude ${args}${bypassFlag}"`;
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
