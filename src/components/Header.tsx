import type { Session } from '../types';

interface HeaderProps {
  session: Session | null;
  connected: boolean;
}

export default function Header({ session, connected }: HeaderProps) {
  return (
    <div className="header">
      <span style={{ fontWeight: 'bold' }}>Claude Code Web UI</span>
      {session && (
        <>
          <span className="session-info">Session: {session.id.slice(0, 8)}…</span>
          {session.model && <span className="model-badge">{session.model}</span>}
          {session.cwd && (
            <span className="session-info" title={session.cwd}>
              {session.cwd.length > 40 ? '…' + session.cwd.slice(-37) : session.cwd}
            </span>
          )}
        </>
      )}
      <div className="status">
        <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
    </div>
  );
}
