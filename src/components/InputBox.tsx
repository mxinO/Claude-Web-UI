import { useState, useRef, useCallback, KeyboardEvent } from 'react';

const MAX_HISTORY = 50;

export default function InputBox() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

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
        // If tmux fails, fall back to mock mode — inject events directly
        if (data.error?.includes('Failed to send') || data.error?.includes('tmux')) {
          setError('No tmux session — using mock mode');
          await simulateEvents(trimmed);
        } else {
          setError(data.error || `Error ${res.status}`);
          return; // don't clear input on error
        }
      }

      // Success — clear input, add to history
      const hist = historyRef.current;
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > MAX_HISTORY) hist.shift();
      }
      historyIndexRef.current = -1;
      setValue('');
    } catch (err) {
      setError(`Network error: ${err}`);
      // don't clear input
    }
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(value);
        return;
      }

      const hist = historyRef.current;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hist.length === 0) return;
        if (historyIndexRef.current === -1) {
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        setValue(hist[historyIndexRef.current]);
      } else if (e.key === 'ArrowDown') {
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
    [value, send]
  );

  return (
    <div className="input-container">
      {error && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', padding: '2px 0', marginBottom: 2 }}>
          {error}
        </div>
      )}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a message or /command..."
        spellCheck={false}
      />
    </div>
  );
}

/** Mock mode: simulate hook events directly when no tmux session */
async function simulateEvents(text: string) {
  // Ensure a session exists
  let sessionId = 'mock-session';
  try {
    const sessRes = await fetch('/api/sessions/latest');
    if (sessRes.ok) {
      const sess = await sessRes.json();
      sessionId = sess.id;
    }
  } catch { /* ignore */ }

  // Create session if needed
  await fetch('/hooks/session-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model: 'mock', cwd: '/mock' }),
  }).catch(() => {});

  // Send user prompt
  await fetch('/hooks/user-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, user_input: text }),
  });

  // Simulate assistant response after a small delay
  setTimeout(async () => {
    await fetch('/hooks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        assistant_message: `[Mock] You said: "${text}". This is mock mode — no Claude Code tmux session is running. Events appear in the timeline to test the UI.`,
        stop_reason: 'end_turn',
      }),
    });
  }, 500);
}
