import { useEffect, useState, useRef, useCallback } from 'react';

interface CwdPickerProps {
  initialCwd: string;
  onConfirm: (cwd: string) => void;
  onCancel: () => void;
}

interface BrowseResponse {
  path: string;
  parent: string;
  dirs: { name: string; path: string }[];
}

/** Modal for picking a working directory: text input + live subdirectory list.
 *  - Typing an absolute path navigates to that directory and shows its children
 *  - Click a child to step in; ".." steps out
 *  - Enter (or Use This Directory) confirms
 */
export default function CwdPicker({ initialCwd, onConfirm, onCancel }: CwdPickerProps) {
  const [pathText, setPathText] = useState(initialCwd);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchBrowse = useCallback(async (p: string) => {
    if (!p.startsWith('/')) {
      setError('Path must be absolute (start with /)');
      setBrowse(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/browse-dirs?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setBrowse(null);
      } else {
        setError(null);
        setBrowse(data as BrowseResponse);
      }
    } catch (err) {
      setError(String(err));
      setBrowse(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on path text change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fetchBrowse(pathText), 200);
    return () => clearTimeout(t);
  }, [pathText, fetchBrowse]);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const stepInto = (childPath: string) => setPathText(childPath);
  const stepUp = () => { if (browse?.parent && browse.parent !== browse.path) setPathText(browse.parent); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(pathText); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 600, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: 16, gap: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 'bold', color: 'var(--text-primary)' }}>
          Choose working directory for the new session
        </div>
        <input
          ref={inputRef}
          value={pathText}
          onChange={(e) => setPathText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          style={{
            padding: '6px 10px', fontSize: 13, fontFamily: 'Consolas, monospace',
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 4, color: 'var(--text-primary)',
          }}
        />
        {error && <div style={{ fontSize: 12, color: 'var(--red, #c33)' }}>{error}</div>}
        <div
          style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-secondary)',
          }}
        >
          {loading && <div style={{ padding: 8, fontSize: 12, color: 'var(--text-secondary)' }}>Loading…</div>}
          {browse && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {browse.parent && browse.parent !== browse.path && (
                <li
                  onClick={stepUp}
                  style={{ padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'Consolas, monospace', color: 'var(--text-secondary)' }}
                >
                  📁 .. (parent)
                </li>
              )}
              {browse.dirs.length === 0 && (
                <li style={{ padding: '4px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>(no subdirectories)</li>
              )}
              {browse.dirs.map((d) => (
                <li
                  key={d.path}
                  onClick={() => stepInto(d.path)}
                  style={{ padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'Consolas, monospace', color: 'var(--text-primary)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  📁 {d.name}/
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ padding: '4px 12px', fontSize: 12, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
          >Cancel</button>
          <button
            onClick={() => onConfirm(pathText)}
            disabled={!!error || !pathText}
            style={{ padding: '4px 12px', fontSize: 12, background: 'var(--text-accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: error ? 0.5 : 1 }}
          >Use this directory</button>
        </div>
      </div>
    </div>
  );
}
