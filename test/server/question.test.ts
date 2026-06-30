import { describe, it, expect } from 'vitest';
import { parseQuestionPane } from '../../server/tmux.js';

const pane = (lines: string[]) => lines.join('\n');

describe('parseQuestionPane', () => {
  it('parses a real AskUserQuestion menu', () => {
    const out = parseQuestionPane(pane([
      ' ☐ Color',
      '',
      'Which color do you prefer?',
      '',
      '❯ 1. Red',
      '     A warm, bold color.',
      '  2. Green',
      '     A cool, natural color.',
      '  3. Blue',
      '     A calm, cool color.',
      '  4. Type something.',
      '────────────────────────────────',
      '  5. Chat about this',
      '',
      ' Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]));
    expect(out).not.toBeNull();
    expect(out!.question).toBe('Which color do you prefer?');
    expect(out!.options).toEqual([
      { index: 1, label: 'Red', description: 'A warm, bold color.' },
      { index: 2, label: 'Green', description: 'A cool, natural color.' },
      { index: 3, label: 'Blue', description: 'A calm, cool color.' },
      { index: 4, label: 'Type something.' },
      { index: 5, label: 'Chat about this' },
    ]);
  });

  it('joins a description that wraps across multiple pane lines', () => {
    const out = parseQuestionPane(pane([
      ' ☐ Deploy target',
      '',
      'Which deployment target do you prefer?',
      '',
      '❯ 1. Staging',
      '     A production-like environment for final validation, but changes',
      '     are isolated from real users so mistakes carry low risk.',
      '  2. Production',
      '     Deploys directly to live users.',
      ' Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]));
    expect(out!.options[0]).toEqual({
      index: 1,
      label: 'Staging',
      description: 'A production-like environment for final validation, but changes are isolated from real users so mistakes carry low risk.',
    });
    expect(out!.options[1].description).toBe('Deploys directly to live users.');
  });

  it('does NOT merge a previously-answered menu still in scrollback', () => {
    // An earlier menu (Q1) sits above the current menu (Q2). Only the current
    // one (just above the footer) should be returned — no duplicate indices.
    const out = parseQuestionPane(pane([
      ' ☐ First',
      'Pick a fruit',
      '❯ 1. Apple',
      '  2. Banana',
      '  3. Cherry',
      '── answered ──',
      ' ☐ Second',
      'Pick a number',
      '❯ 1. One',
      '  2. Two',
      ' Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]));
    expect(out).not.toBeNull();
    expect(out!.question).toBe('Pick a number');
    expect(out!.options).toEqual([
      { index: 1, label: 'One' },
      { index: 2, label: 'Two' },
    ]);
  });

  it('returns null for a permission prompt (different footer)', () => {
    const out = parseQuestionPane(pane([
      ' Do you want to create foo.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits (shift+tab)',
      '   3. No',
      ' Esc to cancel · Tab to amend',
    ]));
    expect(out).toBeNull();
  });

  it('returns null for ordinary assistant text with a numbered list', () => {
    const out = parseQuestionPane(pane([
      '● Here are the steps:',
      '  1. First do this',
      '  2. Then that',
      '❯ ',
    ]));
    expect(out).toBeNull();
  });
});
