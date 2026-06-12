import { useState } from 'react';

export interface QuestionOption { index: number; label: string; }
export interface QuestionData { question: string; options: QuestionOption[]; }

interface Props {
  data: QuestionData;
  onAnswered: () => void;
}

/** Floating bar for Claude's AskUserQuestion menu. Renders each option as a
 *  button; clicking sends the choice to the tmux pane via /api/answer-question.
 *  Free-text ("Type something") and multi-select aren't handled here — those
 *  options still appear as buttons (clicking selects them in the TUI). */
export default function QuestionPrompt({ data, onAnswered }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(index: number) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/answer-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      if (res.ok) {
        onAnswered();
        return;
      }
      const d = await res.json().catch(() => ({}));
      setError(d.error || `Error ${res.status}`);
    } catch (err) {
      setError(`Failed: ${err}`);
    }
    setBusy(false);
  }

  return (
    <div className="question-prompt">
      <div className="question-prompt-title">{data.question || 'Claude is asking…'}</div>
      <div className="question-prompt-options">
        {data.options.map(o => (
          <button
            key={o.index}
            className="question-prompt-option"
            disabled={busy}
            onClick={() => choose(o.index)}
            title={`Option ${o.index}`}
          >
            <span className="question-prompt-num">{o.index}</span>
            {o.label}
          </button>
        ))}
      </div>
      {error && <div className="question-prompt-error">{error}</div>}
    </div>
  );
}
