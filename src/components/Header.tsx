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

  function handleSessionSelect(sessionId: string) {
    setPickerVisible(false);
    // Insert "/resume <id>" into the input box — let user review and press Enter
    window.dispatchEvent(new CustomEvent('insert-input-text', {
      detail: { text: `/resume ${sessionId}` }
    }));
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
