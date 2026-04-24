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
 * Stop polling.
 *
 * Called from two places:
 *   - `stop` hook (end of turn) → pass `quiet=false` (default) so the UI
 *     tears down the streaming preview card.
 *   - `pre-tool-use` hook → pass `quiet=true` so the UI keeps the preview
 *     visible. Streaming resumes in `post-tool-use`; broadcasting
 *     `streaming_done` mid-turn would make the preview flicker between
 *     tool calls.
 */
export function stopStreaming(opts: { quiet?: boolean } = {}): void {
  if (!polling) return;
  polling = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeSessionId && !opts.quiet) {
    broadcast(activeSessionId, 'streaming_done', {});
  }
  // NOTE: `lastText` is intentionally reset only on end-of-turn. When stopping
  // for a tool call, we want the upcoming startStreaming() to reuse it so the
  // first identical capture after resume doesn't re-broadcast the same text.
  if (!opts.quiet) {
    lastText = '';
    activeSessionId = null;
  }
}

/**
 * Parse Claude Code's tmux pane output to extract the current response text.
 *
 * The pane, during streaming, looks like:
 *   ❯ <user prompt line 1>
 *     <user prompt line 2, wrapped>     (indented, no ❯ prefix)
 *   ● <first response block>            (first ● marker)
 *       ⎿ tool card / summary           (tool-use card, shares ● glyph above)
 *   ● <second response block>           (continuation after a tool call)
 *     <continuation lines, 2-sp indent>
 *   ✽ Unfurling… (3s · thinking …)      (optional spinner while generating)
 *   ──────────────                      (bottom separator)
 *   ❯                                   (empty input prompt)
 *
 * Strategy:
 * 1. Find the last `❯ <text>` line — start of the current user message.
 *    This bounds the search so we never anchor on an older turn's `●`.
 * 2. Within that range, find the LAST `●` marker line — the currently
 *    streaming text block (or the most recent tool-use card if no text
 *    has arrived yet). Return null if no `●` exists (still thinking).
 * 3. Collect lines from there to a separator or the empty bottom prompt.
 * 4. Pad the marker with spaces (preserves indent for the dedent pass),
 *    drop thinking-spinner lines and TUI tip blocks, dedent by min-indent.
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

  // Anchor on the LAST `●` marker line after the user prompt. Claude Code
  // renders multiple `●` blocks per turn (one per text block, plus one per
  // tool call); we want to stream only the current block — anything earlier
  // (tool cards, completed prose) is already visible in the final event.
  let responseStart = -1;
  for (let i = lines.length - 1; i > promptIdx; i--) {
    if (RESPONSE_MARKER.test(lines[i])) { responseStart = i; break; }
  }
  if (responseStart === -1) return null;  // no response text yet — just thinking

  // Collect response lines until a turn separator or the bottom empty prompt
  const responseLines: string[] = [];
  for (let i = responseStart; i < lines.length; i++) {
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
