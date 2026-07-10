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
  /** The server's working dir (session cwd, else launch dir) — default for the new-session cwd picker. */
  serverCwd?: string | null;
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
  const [cyclingMode, setCyclingMode] = useState(false);

  // Restart Claude on the SAME session (kill + `--resume <id>`), e.g. to pick
  // up a just-installed skill / changed config. Reuses switch-session.
  async function handleRestart() {
    if (switching || !session) return;
    // Require a known cwd — switch-session falls back to the server's process
    // cwd on an empty value, which would resume Claude in the wrong directory.
    if (!displayCwd) {
      alert('Working directory not known yet — wait a moment and try again.');
      return;
    }
    if (!window.confirm('Restart Claude on this session? It reloads skills/config and resumes the conversation.')) return;
    await handleSessionSelect(session.id, displayCwd);
  }

  function handleNewSession() {
    setPickerVisible(false);
    setCwdPickerVisible(true);
  }

  // Cycle Claude's permission mode (default → accept-edits → plan → bypass → …)
  // by asking the server to send Shift+Tab into the tmux pane.
  async function cyclePermissionMode() {
    if (cyclingMode) return;
    setCyclingMode(true);
    try {
      const res = await fetch('/api/cycle-permission-mode', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.permissionMode) {
        setStatus(s => ({ ...s, permissionMode: data.permissionMode }));
      } else if (data.error) {
        alert(data.error);
      }
    } catch { /* ignore */ }
    setCyclingMode(false);
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Failed to start new session: HTTP ${res.status}`);
        setSwitching(false);
        return;
      }
      // The server may answer before Claude's SessionStart lands (slow start,
      // or Claude waiting on a prompt like folder-trust). Reloading immediately
      // then drops us right back to "no session". Wait until a session actually
      // exists, then reload; otherwise tell the user why nothing happened.
      const data = await res.json().catch(() => ({}));
      if (!data.ready) {
        let ready = false;
        for (let i = 0; i < 40; i++) { // up to ~20s
          await new Promise(r => setTimeout(r, 500));
          const s = await fetch('/api/sessions/latest').then(r => (r.ok ? r.json() : null)).catch(() => null);
          if (s && s.id) { ready = true; break; }
        }
        if (!ready) {
          alert('New session requested, but Claude has not reported a session yet. It may be waiting on a prompt (e.g. folder trust) or failed to start — check the tmux session / server logs, then reload.');
          setSwitching(false);
          return;
        }
      }
      window.location.reload();
      return;
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
      {/* Always render the picker trigger — even with no active session — so
          "New Session" is reachable. Otherwise a startup with no session (e.g.
          a resume that didn't land one) is an unrecoverable dead end. */}
      <span
        ref={sessionIdRef}
        className="session-info session-id-clickable"
        title={session ? 'Click to switch session' : 'Click to start a session'}
        onClick={() => setPickerVisible(v => !v)}
        style={{ position: 'relative' }}
      >
        {switching ? 'Switching...' : session ? `Session: ${session.id.slice(0, 8)}...` : 'No session — click to start'}
        <SessionPicker
          visible={pickerVisible}
          onClose={() => setPickerVisible(false)}
          onSelect={handleSessionSelect}
          onNewSession={handleNewSession}
        />
      </span>
      {session && displayCwd && (
        <span className="session-info" title={displayCwd}>
          {displayCwd.length > 40 ? '...' + displayCwd.slice(-37) : displayCwd}
        </span>
      )}
      {displayModel && <span className="model-badge">{displayModel}</span>}
      {modeLabel && (
        <span
          className="mode-badge mode-badge--clickable"
          style={{ color: modeColor, borderColor: modeColor, opacity: cyclingMode ? 0.5 : 1 }}
          title="Click to cycle permission mode (Shift+Tab)"
          onClick={cyclePermissionMode}
        >
          {modeLabel}
        </span>
      )}
      {status.effort && (
        <span className="effort-badge">
          {status.effort}
        </span>
      )}
      {session && (
        <button
          className="theme-toggle"
          onClick={handleRestart}
          disabled={switching || !displayCwd}
          title="Restart Claude on this session (reload skills/config, resume conversation)"
          style={{ opacity: switching || !displayCwd ? 0.5 : 1 }}
        >
          {'\u21BB'}
        </button>
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
          initialCwd={displayCwd || status.serverCwd || '/'}
          onConfirm={startNewSessionWithCwd}
          onCancel={() => setCwdPickerVisible(false)}
        />
      )}
    </div>
  );
}
