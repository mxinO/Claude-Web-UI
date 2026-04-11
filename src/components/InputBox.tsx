import { useState, useRef, useCallback, KeyboardEvent } from 'react';

const MAX_HISTORY = 50;

export default function InputBox() {
  const [value, setValue] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const draftRef = useRef<string>('');

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Add to history (deduplicate consecutive)
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== trimmed) {
      hist.push(trimmed);
      if (hist.length > MAX_HISTORY) hist.shift();
    }
    historyIndexRef.current = -1;
    draftRef.current = '';

    setValue('');

    try {
      await fetch('/api/send-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
    } catch (err) {
      console.error('Failed to send input:', err);
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
          // Save current draft
          draftRef.current = value;
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        setValue(hist[historyIndexRef.current]);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndexRef.current === -1) return;
        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          setValue(hist[historyIndexRef.current]);
        } else {
          historyIndexRef.current = -1;
          setValue(draftRef.current);
        }
        return;
      }
    },
    [value, send]
  );

  return (
    <div className="input-container">
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Reset history navigation when user types
          if (historyIndexRef.current !== -1) {
            historyIndexRef.current = -1;
            draftRef.current = '';
          }
        }}
        onKeyDown={onKeyDown}
        placeholder="Type a message or /command…"
        spellCheck={false}
      />
    </div>
  );
}
