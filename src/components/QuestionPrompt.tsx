import { useState } from 'react';

export interface QuestionOption { index: number; label: string; description?: string; }
export interface QuestionData { question: string; options: QuestionOption[]; }

interface Props {
  data: QuestionData;
  onAnswered: () => void;
}

// Claude appends two fixed meta-options to every AskUserQuestion menu:
// "Type something." (free-text editor) and "Chat about this". Selecting them
// opens a Vim-style text editor in the TUI that the web UI can't drive with a
// single click, so hide them. Match the exact labels (not a prefix) so a
// genuine choice like "Chat about the design first" isn't wrongly hidden.
// Concrete numbered choices keep their original digits.
const META_OPTION = /^(type something\.?|chat about this)$/i;

/** Floating bar for Claude's AskUserQuestion menu. Renders each concrete
 *  option as a button; clicking sends the choice to the tmux pane via
 *  /api/answer-question. Free-text / chat options are omitted (answer those
 *  directly in the session). */
export default function QuestionPrompt({ data, onAnswered }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = data.options.filter(o => !META_OPTION.test(o.label));
  const hasMeta = options.length !== data.options.length;

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
        {options.map(o => (
          <button
            key={o.index}
            className="question-prompt-option"
            disabled={busy}
            onClick={() => choose(o.index)}
            title={`Option ${o.index}`}
          >
            <span className="question-prompt-num">{o.index}</span>
            <span className="question-prompt-text">
              <span className="question-prompt-label">{o.label}</span>
              {o.description && (
                <span className="question-prompt-desc">{o.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {hasMeta && (
        <div className="question-prompt-hint">
          For a free-text or "chat" answer, reply in the session.
        </div>
      )}
      {error && <div className="question-prompt-error">{error}</div>}
    </div>
  );
}
