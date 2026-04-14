import { useState, useEffect, useRef } from 'react';
import type { Session } from '../types';
import SessionPicker from './SessionPicker';

interface HeaderProps {
  session: Session | null;
  connected: boolean;
}

export default function Header({ session, connected }: HeaderProps) {
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentCwd, setCurrentCwd] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const sessionIdRef = useRef<HTMLSpanElement>(null);

  // Fetch current model on mount and when a command is executed
  useEffect(() => {
    const fetchModel = () => {
      fetch('/api/current-model')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.model) setCurrentModel(data.model);
          if (data?.cwd) setCurrentCwd(data.cwd);
        })
        .catch(() => {});
    };

    fetchModel();

    // Listen for command executions (e.g. /model switch)
    const handler = () => fetchModel();
    window.addEventListener('claude-command-executed', handler);
    return () => window.removeEventListener('claude-command-executed', handler);
  }, []);

  const displayModel = currentModel || session?.model;
  const displayCwd = currentCwd || session?.cwd;

  const [switching, setSwitching] = useState(false);

  async function handleSessionSelect(sessionId: string, cwd: string) {
    if (switching) return;
    setPickerVisible(false);
    setSwitching(true);
    try {
      const res = await fetch('/api/switch-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cwd }),
      });
      if (res.ok) {
        // Reload page — new Claude starts, new DB loads
        window.location.reload();
      }
    } catch { /* ignore */ }
    setSwitching(false);
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
            {switching ? 'Switching...' : `Session: ${session.id.slice(0, 8)}...`}
            <SessionPicker
              visible={pickerVisible}
              onClose={() => setPickerVisible(false)}
              onSelect={handleSessionSelect}
              cwd={session?.cwd || undefined}
            />
          </span>
          {displayCwd && (
            <span className="session-info" title={displayCwd}>
              {displayCwd.length > 40 ? '...' + displayCwd.slice(-37) : displayCwd}
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
