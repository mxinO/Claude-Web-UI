import { useState } from 'react';

interface Props {
  /** The goal condition, if known (may be null briefly before it resolves). */
  condition: string | null;
}

/** Banner shown while a `/goal` is active. Claude works autonomously toward the
 *  condition across turns; this surfaces the condition and a one-click way to
 *  stop early. The banner is driven by the server's goal watcher — it appears
 *  when goal_active is broadcast and disappears on goal_cleared, so the Clear
 *  button only needs to send the stop request; the watcher confirms removal. */
export default function GoalBanner({ condition }: Props) {
  const [clearing, setClearing] = useState(false);

  async function clearGoal() {
    if (clearing) return;
    setClearing(true);
    try {
      await fetch('/api/goal-clear', { method: 'POST' });
      // Don't optimistically hide — the goal watcher broadcasts goal_cleared
      // once the overlay actually disappears, which removes this banner.
    } catch {
      setClearing(false);
    }
  }

  return (
    <div className="goal-banner">
      <span className="goal-banner-icon" aria-hidden>◎</span>
      <span className="goal-banner-label">Goal</span>
      <span className="goal-banner-condition" title={condition ?? undefined}>
        {condition || 'working toward the goal…'}
      </span>
      <button
        className="goal-banner-clear"
        onClick={clearGoal}
        disabled={clearing}
        title="Stop the goal early (/goal clear)"
      >
        {clearing ? 'Clearing…' : 'Clear'}
      </button>
    </div>
  );
}
