/**
 * Streaming output via tmux capture-pane polling.
 *
 * When Claude is "thinking" (between UserPromptSubmit and Stop),
 * polls tmux capture-pane every 500ms, parses Claude's partial output,
 * and broadcasts it to the frontend via WebSocket.
 */

import { execSync } from 'child_process';
import { broadcast } from './websocket.js';
import { TMUX, TMUX_SESSION, TMUX_PANE, getSessionStatus } from './tmux.js';
const POLL_INTERVAL = 400; // ms
// `stdio: pipe` keeps tmux's stderr (e.g. "no server running on …") out of
// the parent process stdout when the session dies mid-poll.
const CAPTURE_OPTS = { encoding: 'utf-8' as const, timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastText = '';
let activeSessionId: string | null = null;
let captureFailCount = 0;

// Set externally to avoid circular imports (streaming ← hooks ← restart ← …).
// The callback receives the session that was active when death was detected.
let onClaudeDead: ((sessionId: string | null) => void) | null = null;
export function setOnClaudeDead(cb: (sessionId: string | null) => void): void {
  onClaudeDead = cb;
}

/**
 * Start polling tmux capture-pane for streaming output.
 * Called when a UserPromptSubmit hook fires.
 */
export function startStreaming(sessionId: string): void {
  if (polling) {
    // If polling for a different session, stop and restart for the new one
    if (activeSessionId === sessionId) return;
    stopStreaming();
  }
  polling = true;
  activeSessionId = sessionId;
  lastText = '';
  captureFailCount = 0;

  pollTimer = setInterval(() => {
    try {
      const paneContent = execSync(
        `${TMUX} capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -50`,
        CAPTURE_OPTS,
      );
      captureFailCount = 0;
      const parsed = parseClaudeOutput(paneContent);
      if (parsed && parsed !== lastText) {
        lastText = parsed;
        broadcast(activeSessionId!, 'streaming', { text: parsed });
      }
    } catch {
      // Transient capture failure is fine. But if tmux keeps failing, the
      // session is probably dead — stop polling so we don't spam the logs
      // and let the UI know Claude is gone.
      captureFailCount++;
      if (captureFailCount >= 3 && !getSessionStatus().alive) {
        const sid = activeSessionId;
        console.error('[streaming] tmux session is dead — stopping poll');
        stopStreaming();
        if (onClaudeDead) {
          onClaudeDead(sid);
        } else if (sid) {
          broadcast(sid, 'claude_dead', {});
        }
      }
    }
  }, POLL_INTERVAL);
}

/**
 * Stop polling. Called when a Stop hook fires.
 */
export function stopStreaming(): void {
  if (!polling) return;
  polling = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Send a final "streaming done" signal
  if (activeSessionId) {
    broadcast(activeSessionId, 'streaming_done', {});
  }
  lastText = '';
  activeSessionId = null;
}

/**
 * Parse Claude Code's tmux pane output to extract the current response.
 *
 * The pane, during streaming, looks like:
 *   ❯ <user prompt line 1>
 *     <user prompt line 2, wrapped>     (indented, no ❯ prefix)
 *                                       (blank line — end of user msg)
 *   ✽ Unfurling… (3s · thinking …)      (optional thinking spinner)
 *     ⎿  Tip: …                         (optional TUI tip + continuation)
 *        …and PRs
 *   ● <response text>                   (response begins)
 *     <response continuation>
 *   ──────────────                      (bottom separator)
 *   ❯                                   (empty input prompt)
 *
 * Strategy:
 * 1. Find the last `❯ <text>` line — start of the current user message.
 * 2. Skip the user message's wrapped continuation until the first blank line.
 * 3. Collect everything after that until a separator or empty prompt.
 * 4. Strip the response/spinner marker, drop thinking spinners and TUI tips
 *    (including multi-line tip continuations), de-indent body text.
 */
// The `●` marker prefixes Claude's final response text.
const RESPONSE_MARKER = /^\s*●\s+/;
// These cycle chars prefix in-progress thinking spinner lines ("Unfurling…").
// Deliberately narrow to known spinner glyphs — `*` is excluded because it's a
// legitimate markdown bullet and `·` because it appears in prose qualifiers.
const SPINNER_MARKER = /^\s*[✢✽✶⚡]\s+/;

export function parseClaudeOutput(paneContent: string): string | null {
  const lines = paneContent.split('\n');

  // Find the last user prompt line (❯ with text after it)
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('❯') && trimmed.length > 2) {
      promptIdx = i;
      break;
    }
  }

  if (promptIdx === -1) return null;

  // Skip the user message's wrapped continuation. Long user messages wrap
  // onto indented lines that don't carry the `❯` prefix; the response only
  // begins after the first blank line.
  let i = promptIdx + 1;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { i++; break; }
    if (trimmed.startsWith('❯')) break;
    i++;
  }

  // Collect response lines until a turn separator or the bottom empty prompt
  const responseLines: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop at separator line
    if (trimmed.match(/^[─━]{5,}$/)) break;
    // Stop at empty prompt (❯ alone or ❯ with whitespace)
    if (trimmed === '❯' || trimmed === '❯ ') break;

    responseLines.push(line);
  }

  if (responseLines.length === 0) return null;

  // Two-pass processing so we can drop spinner lines and tip continuations
  // without misclassifying legitimate response text that happens to share
  // their indent or suffix patterns.
  //
  // Pass 1 — classify and strip:
  //   - Spinner line (`✢ Unfurling…`) → drop.
  //   - Response marker (`● …`) → replace marker with equivalent-width padding
  //     so the dedent pass below sees the true body indent.
  //   - Everything else passes through untouched.
  type Classified = { text: string; isResponseStart: boolean };
  const classified: Classified[] = [];
  for (const line of responseLines) {
    if (SPINNER_MARKER.test(line)) continue;               // drop thinking spinners
    const rm = line.match(RESPONSE_MARKER);
    if (rm) {
      classified.push({ text: ' '.repeat(rm[0].length) + line.slice(rm[0].length), isResponseStart: true });
    } else {
      classified.push({ text: line, isResponseStart: false });
    }
  }

  // Pass 2 — drop TUI tips (`⎿  Tip: …`) and their wrapped continuations.
  // A response-marker line (●) unambiguously ends any tip context, which
  // prevents us from eating an indented code block that follows the tip.
  const cleaned: string[] = [];
  let inTip = false;
  for (const { text: line, isResponseStart } of classified) {
    const trimmed = line.trim();
    if (isResponseStart) { inTip = false; cleaned.push(line); continue; }
    if (trimmed.startsWith('⎿')) { inTip = true; continue; }
    if (inTip) {
      // Continuation: blank or indented 3+ spaces. Body response text lives
      // at the 2-space indent, so 3+ reliably identifies tip wrap-around.
      if (trimmed === '' || /^\s{3,}\S/.test(line)) continue;
      inTip = false;
    }
    cleaned.push(line);
  }

  // Detect common indent (Claude Code uses 2-space indent for body text)
  const nonEmptyLines = cleaned.filter(l => l.trim().length > 0);
  let finalLines = cleaned;
  if (nonEmptyLines.length > 0) {
    const minIndent = Math.min(...nonEmptyLines.map(l => {
      const match = l.match(/^( +)/);
      return match ? match[1].length : 0;
    }));
    if (minIndent > 0) {
      finalLines = cleaned.map(l => {
        if (l.trim().length === 0) return '';
        return l.slice(Math.min(minIndent, l.length - l.trimStart().length));
      });
    }
  }

  const text = finalLines.join('\n').trim();
  return text || null;
}
