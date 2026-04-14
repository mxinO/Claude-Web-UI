import { useState, useEffect } from 'react';
import type { Session } from '../types';

interface HeaderProps {
  session: Session | null;
  connected: boolean;
}

export default function Header({ session, connected }: HeaderProps) {
  const [currentModel, setCurrentModel] = useState<string | null>(null);

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

  return (
    <div className="header">
      <span style={{ fontWeight: 'bold' }}>Claude Code Web UI</span>
      {session && (
        <>
          <span className="session-info">Session: {session.id.slice(0, 8)}...</span>
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
