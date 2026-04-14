import { useState, useEffect } from 'react';

interface ClaudeSession {
  id: string;
  date: string;
  model: string | null;
  name: string | null;
  preview: string | null;
  cwd?: string;
}

interface SessionPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (sessionId: string, cwd: string) => void;
  cwd?: string;
}

export default function SessionPicker({ visible, onClose, onSelect, cwd }: SessionPickerProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    const url = cwd ? `/api/claude-sessions?cwd=${encodeURIComponent(cwd)}` : '/api/claude-sessions';
    fetch(url)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setSessions(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [visible]);

  if (!visible) return null;

  function formatDate(isoStr: string): string {
    try {
      const d = new Date(isoStr);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffH = diffMs / (1000 * 60 * 60);
      if (diffH < 24) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return isoStr;
    }
  }

  function shortModel(model: string | null): string {
    if (!model) return '';
    if (/opus/i.test(model)) return 'Opus';
    if (/sonnet/i.test(model)) return 'Sonnet';
    if (/haiku/i.test(model)) return 'Haiku';
    return model.slice(0, 12);
  }

  return (
    <>
      {/* Backdrop to close on outside click */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 99 }}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      />
      <div className="session-picker" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: 12 }}>
            Loading sessions...
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <div style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: 12 }}>
            No sessions found
          </div>
        )}
        {!loading && sessions.map(s => (
          <div
            key={s.id}
            className="session-picker-item"
            onClick={() => {
              onSelect(s.id, s.cwd || '');
              onClose();
            }}
          >
            <span className="session-picker-date">{formatDate(s.date)}</span>
            <span className="session-picker-model">{shortModel(s.model)}</span>
            <span className="session-picker-preview">
              {s.name || s.preview || s.id.slice(0, 16)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
