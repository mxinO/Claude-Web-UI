import { useState, useEffect, useRef } from 'react';
import type { Session } from '../types';
import SessionPicker from './SessionPicker';
import CwdPicker from './CwdPicker';

interface HeaderProps {
  session: Session | null;
  connected: boolean;
}

interface ClaudeStatus {
  model: string | null;
  cwd: string | null;
  effort: string | null;
  permissionMode: string | null;
  hostname?: string | null;
}

export default function Header({ session, connected }: HeaderProps) {
  const [status, setStatus] = useState<ClaudeStatus>({ model: null, cwd: null, effort: null, permissionMode: null });
  const [pickerVisible, setPickerVisible] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'; }
    catch { return 'dark'; }
  });

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);
  const sessionIdRef = useRef<HTMLSpanElement>(null);

  // Fetch status on mount and when a command is executed
  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/current-status')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setStatus(data); })
        .catch(() => {});
    };

    fetchStatus();

    const handler = () => fetchStatus();
    window.addEventListener('claude-command-executed', handler);
    return () => window.removeEventListener('claude-command-executed', handler);
  }, []);

  const displayModel = status.model || session?.model;
  const displayCwd = status.cwd || session?.cwd;

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
        window.location.reload();
      }
    } catch { /* ignore */ }
    setSwitching(false);
  }

  const [cwdPickerVisible, setCwdPickerVisible] = useState(false);

  function handleNewSession() {
    setPickerVisible(false);
    setCwdPickerVisible(true);
  }

  async function startNewSessionWithCwd(cwd: string) {
    if (switching) return;
    setCwdPickerVisible(false);
    setSwitching(true);
    try {
      const res = await fetch('/api/new-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Failed to start new session: HTTP ${res.status}`);
    } catch (err) {
      alert(`Failed to start new session: ${err}`);
    }
    setSwitching(false);
  }

  // Mode badge color
  const modeColor = status.permissionMode === 'plan' ? 'var(--yellow)'
    : status.permissionMode === 'bypass' ? 'var(--red)'
    : status.permissionMode === 'auto' ? 'var(--green)'
    : 'var(--text-secondary)';

  const modeLabel = status.permissionMode === 'plan' ? 'Plan Mode'
    : status.permissionMode === 'bypass' ? 'Bypass'
    : status.permissionMode === 'auto' ? 'Auto'
    : status.permissionMode === 'acceptEdits' ? 'Accept Edits'
    : status.permissionMode === 'default' ? 'Default'
    : null;

  return (
    <div className="header" style={{ position: 'relative' }}>
      <span style={{ fontWeight: 'bold' }}>Claude Code Web UI</span>
      {status.hostname && (
        <span className="session-info" title={`Server hostname: ${status.hostname}`}>
          @{status.hostname}
        </span>
      )}
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
              onNewSession={handleNewSession}
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
      {modeLabel && (
        <span className="mode-badge" style={{ color: modeColor, borderColor: modeColor }}>
          {modeLabel}
        </span>
      )}
      {status.effort && (
        <span className="effort-badge">
          {status.effort}
        </span>
      )}
      <button
        className="theme-toggle"
        onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '\u2600' : '\u263E'}
      </button>
      <div className="status">
        <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
      {cwdPickerVisible && (
        <CwdPicker
          initialCwd={displayCwd || '/'}
          onConfirm={startNewSessionWithCwd}
          onCancel={() => setCwdPickerVisible(false)}
        />
      )}
    </div>
  );
}
