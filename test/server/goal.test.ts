import { describe, it, expect } from 'vitest';
import { parseGoalPane } from '../../server/tmux.js';

const pane = (lines: string[]) => lines.join('\n');

describe('parseGoalPane', () => {
  it('detects an active goal from the status-line overlay', () => {
    // Real capture: the overlay is appended to whatever tip the hint line shows.
    const out = parseGoalPane(pane([
      '* Photosynthesizing…',
      "  tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' · ◎ /goal active",
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
      '  ⏵⏵ bypass permissions on · esc to interrupt',
    ]));
    expect(out.active).toBe(true);
    expect(out.result).toBeNull();
  });

  it('parses the condition from the latest "Goal set:" line', () => {
    const out = parseGoalPane(pane([
      '❯ /goal the file READY exists in this directory, then stop',
      '  ⎿  Goal set: the file READY exists in this directory, then stop',
      '  tmux detected · ◎ /goal active',
    ]));
    expect(out.active).toBe(true);
    expect(out.condition).toBe('the file READY exists in this directory, then stop');
  });

  it('reports achieved when the overlay is gone and the achieved marker is shown', () => {
    const out = parseGoalPane(pane([
      '  ⎿  Goal set: make tests pass',
      '● The goal is met.',
      '✔ Goal achieved (8s · 1 turn · 278 tokens)',
      '✻ Baked for 8s',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out.active).toBe(false);
    expect(out.result).toBe('achieved');
  });

  it('reports cleared / failed terminal states', () => {
    expect(parseGoalPane(pane(['Goal cleared'])).result).toBe('cleared');
    expect(parseGoalPane(pane(['Goal could not be achieved'])).result).toBe('failed');
  });

  it('returns the MOST RECENT terminal marker when an old one lingers above', () => {
    // A previous goal achieved; a newer one was cleared. The bottom-most wins.
    const out = parseGoalPane(pane([
      '✔ Goal achieved (3s · 1 turn · 50 tokens)',
      '… later …',
      'Goal cleared',
      '❯ ',
    ]));
    expect(out.result).toBe('cleared');
  });

  it('does NOT report active from transcript scrollback containing "/goal active"', () => {
    // Claude explaining the feature in its response (deep in scrollback) must
    // not be mistaken for the live overlay, which only sits near the bottom.
    const out = parseGoalPane(pane([
      '● The web UI detects the "/goal active" overlay to show a banner.',
      'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line',
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
      '  ⏵⏵ bypass permissions on · ← for agents',
    ]));
    expect(out.active).toBe(false);
  });

  it('still detects the overlay in the tail even with transcript text above', () => {
    const out = parseGoalPane(pane([
      '● Some earlier mention of /goal active in prose.',
      'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line',
      '  tmux detected · scroll with PgUp/PgDn · ◎ /goal active',
      '────────────────────────────────',
      '❯ ',
      '  ⏵⏵ esc to interrupt',
    ]));
    expect(out.active).toBe(true);
  });

  it('is inactive for an ordinary pane with no goal', () => {
    const out = parseGoalPane(pane([
      '● Here is the answer.',
      '────────────────────────────────',
      '❯ ',
    ]));
    expect(out.active).toBe(false);
    expect(out.condition).toBeNull();
    expect(out.result).toBeNull();
  });
});
