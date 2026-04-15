/**
 * Streaming output via tmux capture-pane polling.
 *
 * When Claude is "thinking" (between UserPromptSubmit and Stop),
 * polls tmux capture-pane every 500ms, parses Claude's partial output,
 * and broadcasts it to the frontend via WebSocket.
 */

import { execSync } from 'child_process';
import { broadcast } from './websocket.js';

const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
const TMUX_PANE = process.env.CLAUDE_TMUX_PANE || '0';
const POLL_INTERVAL = 400; // ms

let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastText = '';
let activeSessionId: string | null = null;

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

  pollTimer = setInterval(() => {
    try {
      const paneContent = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -50`,
        { encoding: 'utf-8', timeout: 2000 }
      );
      const parsed = parseClaudeOutput(paneContent);
      if (parsed && parsed !== lastText) {
        lastText = parsed;
        broadcast(activeSessionId!, 'streaming', { text: parsed });
      }
    } catch {
      // capture failed — ignore
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
 * The pane looks like:
 *   ❯ <user prompt>
 *   ● <response text>        (or ✢ Flowing…)
 *   ──────────────           (separator)
 *   ❯                        (next prompt)
 *
 * We find the last `❯ ` line (user prompt), then collect everything
 * after it until the separator `───` line.
 */
function parseClaudeOutput(paneContent: string): string | null {
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

  // Collect response lines after the prompt, until separator or empty prompt
  const responseLines: string[] = [];
  for (let i = promptIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop at separator line
    if (trimmed.match(/^[─━]{5,}$/)) break;
    // Stop at empty prompt (❯ alone or ❯ with whitespace)
    if (trimmed === '❯' || trimmed === '❯ ') break;

    responseLines.push(line);
  }

  if (responseLines.length === 0) return null;

  // Claude Code's TUI indents response text with 2 spaces.
  // Strip common leading whitespace to get clean text for markdown rendering.
  let cleaned = responseLines
    // Remove the response marker line (● or ✢ prefix)
    .map(line => {
      // First line often starts with ● or ✢
      const markerMatch = line.match(/^\s*[●✢✶⚡]\s*/);
      if (markerMatch) return line.slice(markerMatch[0].length);
      return line;
    })
    // Remove status lines
    .filter(line => !line.trim().match(/^(Flowing|Blanching|Thinking|Cooking|Simmering|Brewing)…$/i))
    // Remove tip lines
    .filter(line => !line.trim().startsWith('⎿'));

  // Detect common indent (Claude Code uses 2-space indent for body text)
  const nonEmptyLines = cleaned.filter(l => l.trim().length > 0);
  if (nonEmptyLines.length > 0) {
    const minIndent = Math.min(...nonEmptyLines.map(l => {
      const match = l.match(/^( +)/);
      return match ? match[1].length : 0;
    }));
    if (minIndent > 0) {
      cleaned = cleaned.map(l => {
        if (l.trim().length === 0) return '';
        return l.slice(Math.min(minIndent, l.length - l.trimStart().length));
      });
    }
  }

  const text = cleaned.join('\n').trim();
  return text || null;
}
