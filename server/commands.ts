/**
 * Scrape the slash command list from the managed Claude Code TUI.
 *
 * On startup, types `/` in the tmux pane, captures the dropdown,
 * scrolls through all entries, then presses Escape to dismiss.
 * Caches the result for the lifetime of the server.
 */

import { execSync } from 'child_process';

const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
const TMUX_PANE = process.env.CLAUDE_TMUX_PANE || '0';

export interface SlashCommand {
  command: string;
  description: string;
  category?: string; // 'built-in' | 'superpowers' | 'bundled' | 'skill'
}

let cachedCommands: SlashCommand[] | null = null;

export function getCachedCommands(): SlashCommand[] {
  return cachedCommands || [];
}

/**
 * Scrape commands from the Claude TUI. Call after Claude is ready (past trust prompt).
 * Returns the list and caches it.
 */
export async function scrapeCommands(): Promise<SlashCommand[]> {
  const commands = new Map<string, SlashCommand>();

  try {
    // Type / to open the command dropdown
    exec(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} /`);
    await sleep(800);

    // Capture and parse multiple pages
    const maxPages = 15; // safety limit
    let lastCapture = '';
    let seenRepeat = 0;

    for (let page = 0; page < maxPages; page++) {
      const capture = exec(`tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -30`);

      // Parse command lines from the capture
      const newCommands = parseCommandLines(capture);
      let addedNew = false;
      for (const cmd of newCommands) {
        if (!commands.has(cmd.command)) {
          commands.set(cmd.command, cmd);
          addedNew = true;
        }
      }

      // Check if we've looped (same content as before)
      if (capture === lastCapture || !addedNew) {
        seenRepeat++;
        if (seenRepeat >= 2) break; // looped back to start
      } else {
        seenRepeat = 0;
      }
      lastCapture = capture;

      // Scroll down to see more
      for (let i = 0; i < 6; i++) {
        exec(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Down`);
      }
      await sleep(200);
    }

    // Dismiss the dropdown
    exec(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Escape`);
    await sleep(200);
    // Clear the / from the input
    exec(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} BSpace`);

  } catch (err) {
    console.error('Failed to scrape commands:', err);
  }

  const result = Array.from(commands.values()).sort((a, b) => a.command.localeCompare(b.command));
  cachedCommands = result;
  console.log(`Scraped ${result.length} slash commands from Claude TUI`);
  return result;
}

/**
 * Parse command entries from a tmux capture.
 * Lines look like: /command-name    Description text here...
 */
function parseCommandLines(capture: string): SlashCommand[] {
  const results: SlashCommand[] = [];
  const lines = capture.split('\n');

  for (const line of lines) {
    // Match lines that start with / followed by a command name and description
    const match = line.match(/^(\/[\w:_-]+)\s{2,}(.+)$/);
    if (match) {
      const command = match[1];
      let description = match[2].trim();

      // Detect category from description
      let category = 'built-in';
      if (description.startsWith('(superpowers)')) {
        category = 'superpowers';
        description = description.replace(/^\(superpowers\)\s*/, '');
      } else if (description.startsWith('(bundled)')) {
        category = 'bundled';
        description = description.replace(/^\(bundled\)\s*/, '');
      }

      // Truncate long descriptions (TUI truncates with …)
      if (description.endsWith('…')) {
        description = description.slice(0, -1) + '...';
      }

      results.push({ command, description, category });
    }
  }

  return results;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 3000 });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
