import { describe, it, expect } from 'vitest';
import { parseClaudeOutput } from '../../server/streaming.js';

/** Build a fake `tmux capture-pane` output from an array of lines. */
const pane = (lines: string[]) => lines.join('\n');

describe('parseClaudeOutput', () => {
  it('extracts a clean haiku response', () => {
    const out = parseClaudeOutput(pane([
      '❯ write a 3-sentence haiku about autumn',
      '',
      '● Crimson leaves let go,',
      '  river carries them downstream—',
      '  first breath of winter.',
      '',
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
      '  ⏵⏵ bypass permissions',
    ]));
    expect(out).toBe('Crimson leaves let go,\nriver carries them downstream—\nfirst breath of winter.');
  });

  it('handles a multi-line (wrapped) user message', () => {
    const out = parseClaudeOutput(pane([
      '❯ write a very long limerick about software engineering, take your time and use',
      '   rich vocabulary',
      '',
      '● A programmer named Grace wrote some code,',
      '  That refused to compile or unload.',
      '',
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
    ]));
    expect(out).toBe('A programmer named Grace wrote some code,\nThat refused to compile or unload.');
  });

  it('filters thinking spinner + tip lines during streaming start', () => {
    const out = parseClaudeOutput(pane([
      '❯ write a very long limerick about software engineering, take your time and use',
      '   rich vocabulary',
      '',
      '✽ Unfurling… (3s · thinking with high effort)',
      '  ⎿  Tip: Run /install-github-app to tag @claude right from your Github issues',
      '     and PRs',
      '',
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
    ]));
    // Before the response arrives, there's nothing meaningful to show.
    expect(out).toBeNull();
  });

  it('picks up partial response text past the tip + spinner', () => {
    const out = parseClaudeOutput(pane([
      '❯ explain closures in javascript',
      '',
      '✽ Flowing… (2s · thinking)',
      '  ⎿  Tip: something',
      '',
      '● A closure is a function that remembers',
      '  the variables from its enclosing scope.',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('A closure is a function that remembers\nthe variables from its enclosing scope.');
  });

  it('returns null when no user prompt is present', () => {
    expect(parseClaudeOutput(pane([
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
    ]))).toBeNull();
  });

  it('handles the ✢ spinner marker too', () => {
    const out = parseClaudeOutput(pane([
      '❯ hi',
      '',
      '✢ Thinking… (1s)',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBeNull();
  });

  it('preserves markdown bullets (asterisk) in the response body', () => {
    const out = parseClaudeOutput(pane([
      '❯ list 3 colors',
      '',
      '● Here you go:',
      '  * Red',
      '  * Green',
      '  * Blue',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('Here you go:\n* Red\n* Green\n* Blue');
  });

  it('keeps a single-word ellipsis line in the response body', () => {
    const out = parseClaudeOutput(pane([
      '❯ demo',
      '',
      '● Investigating…',
      '  results below.',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('Investigating…\nresults below.');
  });

  it('does not eat an indented code block after a tip', () => {
    const out = parseClaudeOutput(pane([
      '❯ show code',
      '',
      '  ⎿  Tip: something unhelpful',
      '     continues here',
      '● Here is the snippet:',
      '      const x = 1;',
      '      const y = 2;',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('Here is the snippet:\n    const x = 1;\n    const y = 2;');
  });

  it('tolerates a user message that itself contains ❯', () => {
    const out = parseClaudeOutput(pane([
      '❯ explain the ❯ prompt character',
      '',
      '● It is the U+276F chevron glyph.',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('It is the U+276F chevron glyph.');
  });

  it('streams only the current text block, skipping earlier tool-use cards', () => {
    // Multi-block turn: Claude said something, used a tool, is now writing the
    // final answer. We should preview only the latest ● block.
    const out = parseClaudeOutput(pane([
      '❯ run ls and tell me the largest file',
      '',
      '● Let me check the directory.',
      '  Listed 1 directory (ctrl+o to expand)',
      '',
      '● Largest file: api.ts at 42,677 bytes (~42 KB).',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('Largest file: api.ts at 42,677 bytes (~42 KB).');
  });

  it('shows the running tool summary when no response text exists yet', () => {
    // Mid-tool state: the only ● is the tool-use card itself.
    const out = parseClaudeOutput(pane([
      '❯ run ls',
      '',
      '● Listing 1 directory… (ctrl+o to expand)',
      '  ⎿  $ ls -la /tmp',
      '',
      '✶ Channeling… (5s · ↓ 164 tokens · thinking with high effort)',
      '',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out).toBe('Listing 1 directory… (ctrl+o to expand)');
  });
});
