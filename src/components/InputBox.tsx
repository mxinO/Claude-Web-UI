import { useState, useRef, useCallback, KeyboardEvent, useEffect } from 'react';

const MAX_HISTORY = 50;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT = 20; // px

export default function InputBox() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    const maxH = LINE_HEIGHT * MAX_ROWS + 12; // 12px padding
    el.style.height = `${Math.min(scrollH, maxH)}px`;
  }, [value]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError('');

    try {
      const res = await fetch('/api/send-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error?.includes('Failed to send') || data.error?.includes('tmux')) {
          setError('No tmux session \u2014 using mock mode');
          await simulateEvents(trimmed);
        } else {
          setError(data.error || `Error ${res.status}`);
          return;
        }
      }

      const hist = historyRef.current;
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > MAX_HISTORY) hist.shift();
      }
      historyIndexRef.current = -1;
      setValue('');
    } catch (err) {
      setError(`Network error: ${err}`);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter inserts newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(value);
        return;
      }

      const hist = historyRef.current;
      // Only use arrow-key history when the textarea has a single line
      const isMultiline = value.includes('\n');
      if (!isMultiline && e.key === 'ArrowUp') {
        e.preventDefault();
        if (hist.length === 0) return;
        if (historyIndexRef.current === -1) {
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        setValue(hist[historyIndexRef.current]);
      } else if (!isMultiline && e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndexRef.current === -1) return;
        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          setValue(hist[historyIndexRef.current]);
        } else {
          historyIndexRef.current = -1;
          setValue('');
        }
      }
    },
    [value, send],
  );

  return (
    <div className="input-container">
      {error && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', padding: '2px 0', marginBottom: 2, width: '100%' }}>
          {error}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a message or /command... (Shift+Enter for newline)"
        spellCheck={false}
        rows={MIN_ROWS}
      />
    </div>
  );
}

/** Mock mode: simulate hook events directly when no tmux session */
async function simulateEvents(text: string) {
  let sessionId = 'mock-session';
  try {
    const sessRes = await fetch('/api/sessions/latest');
    if (sessRes.ok) {
      const sess = await sessRes.json();
      sessionId = sess.id;
    }
  } catch { /* ignore */ }

  await fetch('/hooks/session-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model: 'mock', cwd: '/mock' }),
  }).catch(() => {});

  await fetch('/hooks/user-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, user_input: text }),
  });

  setTimeout(async () => {
    await fetch('/hooks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        assistant_message: `[Mock] You said: "${text}". This is mock mode \u2014 no Claude Code tmux session is running.`,
        stop_reason: 'end_turn',
      }),
    });
  }, 500);
}
