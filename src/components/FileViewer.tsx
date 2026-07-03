import { useState, useEffect } from 'react';
import { MarkdownView } from './MarkdownView';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const MD_EXTS = ['md', 'markdown', 'mdx'];
// Formats the browser renders on its own — open these straight in a new tab via
// the streaming /api/file endpoint (Content-Type drives the browser's viewer)
// rather than the in-app panel, which can't display them inline.
const NEW_TAB_EXTS = ['pdf', 'html', 'htm'];
// Inline as text. Everything else (unknown / likely binary) gets the
// "open in new tab" affordance instead of dumping bytes into a <pre>.
const TEXT_EXTS = [
  'txt', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cc', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish', 'sql', 'css', 'scss', 'less', 'vue', 'svelte',
  'r', 'lua', 'pl', 'dart', 'scala', 'clj', 'ex', 'exs', 'gradle', 'properties', 'diff', 'patch',
];
const TEXT_NAMES = ['dockerfile', 'makefile', 'readme', 'license', 'gitignore', 'npmrc', 'gemfile'];

type Kind = 'image' | 'markdown' | 'native' | 'text';

/** The streaming file endpoint URL for a path. */
export function fileApiUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

/** True if the file should open directly in a new browser tab (pdf/html) rather
 *  than the in-app viewer panel. */
export function shouldOpenInNewTab(path: string): boolean {
  const base = path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return NEW_TAB_EXTS.includes(ext);
}

function classify(filePath: string): Kind {
  const base = filePath.split('/').pop() || filePath;
  // lastIndexOf('.') > 0 so leading-dot files (.gitignore, .npmrc) have ext=''
  // and are treated as text rather than "native".
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (MD_EXTS.includes(ext)) return 'markdown';
  if (NEW_TAB_EXTS.includes(ext)) return 'native';
  if (TEXT_EXTS.includes(ext)) return 'text';
  if (!ext && TEXT_NAMES.includes(base.replace(/^\./, '').toLowerCase())) return 'text';
  // No/unknown extension: extensionless (README, LICENSE, .gitignore) → text;
  // unknown binary-ish extension → native (offer open-in-tab).
  return ext ? 'native' : 'text';
}

interface Props { path: string; onClose: () => void; }

export default function FileViewer({ path, onClose }: Props) {
  const url = fileApiUrl(path);
  const kind = classify(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [rawMd, setRawMd] = useState(false);

  useEffect(() => {
    if (kind === 'image' || kind === 'native') return; // no JS-side fetch needed
    let cancelled = false;
    setText(null);
    setError('');
    fetch(url)
      .then(r => (r.ok ? r.text() : r.json().then(d => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))))
      .then(t => { if (!cancelled) setText(t); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [url, kind]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()} style={{ width: '72vw', height: '78vh' }}>
        <div className="modal-header">
          <span className="modal-title" title={path}>{path}</span>
          {kind === 'markdown' && (
            <button className="fv-btn" onClick={() => setRawMd(r => !r)}>
              {rawMd ? 'Preview' : 'Raw'}
            </button>
          )}
          <a className="fv-btn" href={url} target="_blank" rel="noopener noreferrer">Open raw ↗</a>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div
          className="modal-body"
          style={{ display: 'flex', alignItems: kind === 'image' || kind === 'native' ? 'center' : 'stretch', justifyContent: 'center' }}
        >
          {kind === 'image' && (
            <img src={url} alt={path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
          {kind === 'native' && (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              <p>This file type opens in your browser.</p>
              <a className="fv-btn fv-btn--primary" href={url} target="_blank" rel="noopener noreferrer">
                Open in new tab ↗
              </a>
            </div>
          )}
          {kind === 'markdown' && (
            error ? <div className="fv-error">{error}</div>
              : text === null ? <div className="fv-loading">Loading…</div>
                : rawMd
                  ? <pre className="bash-output" style={{ maxHeight: 'none', width: '100%', margin: 0 }}>{text}</pre>
                  : <div style={{ width: '100%', overflow: 'auto' }}><MarkdownView content={text} /></div>
          )}
          {kind === 'text' && (
            error ? <div className="fv-error">{error}</div>
              : text === null ? <div className="fv-loading">Loading…</div>
                : <pre className="bash-output" style={{ maxHeight: 'none', width: '100%', margin: 0 }}>{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
