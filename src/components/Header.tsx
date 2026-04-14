import { useState, useEffect, useRef } from 'react';
import type { Session } from '../types';
import SessionPicker from './SessionPicker';

interface HeaderProps {
  session: Session | null;
  connected: boolean;
}

export default function Header({ session, connected }: HeaderProps) {
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const sessionIdRef = useRef<HTMLSpanElement>(null);

  // Fetch current model on mount and when a command is executed
  useEffect(() => {
    const fetchModel = () => {
      fetch('/api/current-model')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.model) setCurrentModel(data.model); })
        .catch(() => {});
    };

    fetchModel();

    // Listen for command executions (e.g. /model switch)
    const handler = () => fetchModel();
    window.addEventListener('claude-command-executed', handler);
    return () => window.removeEventListener('claude-command-executed', handler);
  }, []);

  const displayModel = currentModel || session?.model;

  const [resuming, setResuming] = useState(false);

  async function handleSessionSelect(sessionId: string) {
    if (resuming) return; // prevent double-click
    setPickerVisible(false);
    setResuming(true);
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `/resume ${sessionId}` }),
      });
      const data = await res.json();
      if (data.response) {
        window.dispatchEvent(new CustomEvent('claude-command-executed', {
          detail: { command: '/resume', response: data.response }
        }));
      }
    } catch { /* ignore */ }
    setResuming(false);
  }

  return (
    <div className="header" style={{ position: 'relative' }}>
      <span style={{ fontWeight: 'bold' }}>Claude Code Web UI</span>
      {session && (
        <>
          <span
            ref={sessionIdRef}
            className="session-info session-id-clickable"
            title="Click to switch session"
            onClick={() => setPickerVisible(v => !v)}
            style={{ position: 'relative' }}
          >
            Session: {session.id.slice(0, 8)}...
            <SessionPicker
              visible={pickerVisible}
              onClose={() => setPickerVisible(false)}
              onSelect={handleSessionSelect}
              cwd={session?.cwd || undefined}
            />
          </span>
          {session.cwd && (
            <span className="session-info" title={session.cwd}>
              {session.cwd.length > 40 ? '...' + session.cwd.slice(-37) : session.cwd}
            </span>
          )}
        </>
      )}
      {displayModel && <span className="model-badge">{displayModel}</span>}
      <div className="status">
        <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
    </div>
  );
}
