import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import type { TimelineEvent } from '../types';
import { MarkdownView } from './MarkdownView';
import { BashOutput } from './BashOutput';
import { detectLanguage } from '../lib/detectLanguage';

const LazyDiffViewer = lazy(() =>
  import('./DiffViewer').then((m) => ({ default: m.DiffViewer }))
);

interface DetailModalProps {
  event: TimelineEvent;
  onClose: () => void;
}

function parseToolInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

/** Parse the diff snippet stored in file_before (JSON: {before, after}) */
function parseDiffSnippet(raw: string | null): { before: string; after: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed.before !== undefined && parsed.after !== undefined) {
      return { before: parsed.before, after: parsed.after };
    }
    // Legacy format: file_before is the raw "before" content string
    return null;
  } catch {
    // Legacy: file_before is a raw string (old events before the snippet change)
    return null;
  }
}

function getTitle(event: TimelineEvent): string {
  switch (event.event_type) {
    case 'user_message': return 'User Message';
    case 'assistant_message': return 'Assistant Message';
    case 'tool_use':
    case 'tool_result': {
      const toolName = event.tool_name || 'unknown';
      // For file-modifying tools, append the path so the header tells the
      // whole story without needing to scroll the diff.
      const tn = toolName.toLowerCase();
      if (tn === 'edit' || tn === 'multiedit' || tn === 'write') {
        const input = parseToolInput(event.tool_input);
        const filePath = (input.file_path as string) || '';
        if (filePath) return `Tool: ${toolName} — ${filePath}`;
      }
      return `Tool: ${toolName}`;
    }
    case 'permission_request': return 'Permission Request';
    case 'subagent_stop': return 'Subagent Result';
    default: return event.event_type;
  }
}

/* ── Full file viewer (fetches on demand) ──────────────────────── */

function FullFileButton({ filePath }: { filePath: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [content, setContent] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setContent(data.content);
      setState('idle');
    } catch (err) {
      setState('error');
      setContent(String(err));
    }
  }, [filePath]);

  if (content) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Full file: {filePath}
          <button
            onClick={() => setContent(null)}
            style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--text-accent)', cursor: 'pointer', fontSize: 11 }}
          >
            collapse
          </button>
        </div>
        <pre style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 4, padding: 12, overflow: 'auto', maxHeight: 400,
          fontSize: 12, fontFamily: 'Consolas, monospace', color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap', margin: 0,
        }}>
          {content}
        </pre>
      </div>
    );
  }

  return (
    <button
      onClick={loadFile}
      disabled={state === 'loading'}
      style={{
        marginTop: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
        borderRadius: 4, padding: '4px 10px', color: 'var(--text-accent)',
        cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
      }}
    >
      {state === 'loading' ? 'Loading...' : state === 'error' ? 'Error — retry' : 'View full file'}
    </button>
  );
}

/* ── Edit diff ──────────────────────────────────────────────────── */

function EditDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.file_path as string) || '';
  const oldString = (input.old_string as string) ?? '';
  const newString = (input.new_string as string) ?? '';
  const language = detectLanguage(filePath);

  const snippet = parseDiffSnippet(event.file_before);

  let original: string;
  let modified: string;

  if (snippet) {
    // New format: use the context snippet
    original = snippet.before;
    modified = snippet.after;
  } else if (event.file_before && typeof event.file_before === 'string') {
    // Legacy format: file_before is full "before" content
    original = event.file_before;
    modified = event.file_before.replace(oldString, newString);
  } else {
    // No context: just show the changed strings
    original = oldString;
    modified = newString;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div className="modal-loading">Loading diff editor...</div>}>
          <LazyDiffViewer original={original} modified={modified} language={language} fileName={filePath} />
        </Suspense>
      </div>
      {filePath && <FullFileButton filePath={filePath} />}
    </div>
  );
}

/* ── Write diff ─────────────────────────────────────────────────── */

function WriteDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.file_path as string) || '';
  const language = detectLanguage(filePath);

  const snippet = parseDiffSnippet(event.file_before);

  let original: string;
  let modified: string;

  if (snippet) {
    original = snippet.before;
    modified = snippet.after;
  } else {
    // Legacy or no snippet
    original = (typeof event.file_before === 'string') ? event.file_before : '';
    modified = (input.content as string) ?? '';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div className="modal-loading">Loading diff editor...</div>}>
          <LazyDiffViewer original={original} modified={modified} language={language} fileName={filePath} />
        </Suspense>
      </div>
      {filePath && <FullFileButton filePath={filePath} />}
    </div>
  );
}

/* ── Detail content router ────────────────────────────────────── */

function DetailContent({ event }: { event: TimelineEvent }) {
  switch (event.event_type) {
    case 'user_message':
    case 'assistant_message':
      return <MarkdownView content={event.message_text ?? ''} />;

    case 'tool_use':
    case 'tool_result': {
      const toolName = event.tool_name?.toLowerCase() ?? '';

      if (toolName === 'edit' || toolName === 'multiedit') return <EditDiff event={event} />;
      if (toolName === 'write') return <WriteDiff event={event} />;
      if (toolName === 'bash') {
        const input = parseToolInput(event.tool_input);
        const command = (input.command as string) ?? '';
        // tool_response is stored as JSON string — try to extract output
        let output = event.tool_response ?? '';
        try {
          const parsed = JSON.parse(output);
          output = parsed.stdout || parsed.output || JSON.stringify(parsed, null, 2);
        } catch { /* use raw */ }
        return <BashOutput command={command} output={output} />;
      }

      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
          {JSON.stringify({ tool_name: event.tool_name, tool_input: parseToolInput(event.tool_input), tool_response: event.tool_response, status: event.status }, null, 2)}
        </pre>
      );
    }

    case 'permission_request': {
      const input = parseToolInput(event.tool_input);
      const tn = (event.tool_name || '').toLowerCase();

      // For Write: show file path and content preview
      if (tn === 'write' && input.content) {
        const filePath = (input.file_path as string) || '';
        const language = detectLanguage(filePath);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 0', fontSize: 13 }}>
              <strong>Write to:</strong> {filePath}
              <span style={{ marginLeft: 12, color: 'var(--text-secondary)' }}>
                ({((input.content as string) || '').split('\n').length} lines)
              </span>
              <span style={{ marginLeft: 12, color: event.status === 'pending' ? 'var(--yellow)' : 'var(--text-secondary)' }}>
                Status: {event.status}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <Suspense fallback={<div className="modal-loading">Loading editor...</div>}>
                <LazyDiffViewer original="" modified={input.content as string} language={language} fileName={filePath} />
              </Suspense>
            </div>
            {filePath && <FullFileButton filePath={filePath} />}
          </div>
        );
      }

      // For Edit: show diff
      if (tn === 'edit' && input.old_string) {
        const filePath = (input.file_path as string) || '';
        const language = detectLanguage(filePath);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 0', fontSize: 13 }}>
              <strong>Edit:</strong> {filePath}
              <span style={{ marginLeft: 12, color: event.status === 'pending' ? 'var(--yellow)' : 'var(--text-secondary)' }}>
                Status: {event.status}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <Suspense fallback={<div className="modal-loading">Loading diff...</div>}>
                <LazyDiffViewer
                  original={input.old_string as string}
                  modified={input.new_string as string}
                  language={language}
                  fileName={filePath}
                />
              </Suspense>
            </div>
          </div>
        );
      }

      // For Bash: show command
      if (tn === 'bash' && input.command) {
        return (
          <div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>Command:</strong>
              <span style={{ marginLeft: 12, color: event.status === 'pending' ? 'var(--yellow)' : 'var(--text-secondary)' }}>
                Status: {event.status}
              </span>
            </div>
            <pre style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 4, padding: 12, fontSize: 13, fontFamily: 'Consolas, monospace',
              color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              $ {input.command as string}
            </pre>
          </div>
        );
      }

      // Generic: JSON dump
      return (
        <div>
          <div><strong>Tool:</strong> {event.tool_name}</div>
          <div><strong>Status:</strong> {event.status}</div>
          <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      );
    }

    case 'subagent_stop':
      return <MarkdownView content={event.message_text ?? ''} />;

    default:
      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
          {JSON.stringify(event, null, 2)}
        </pre>
      );
  }
}

/* ── Modal ─────────────────────────────────────────────────────── */

export default function DetailModal({ event, onClose }: DetailModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const title = getTitle(event);
  const isEditOrWrite =
    (event.event_type === 'tool_use' || event.event_type === 'tool_result') &&
    ['edit', 'write', 'multiedit'].includes((event.tool_name ?? '').toLowerCase());

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal-container ${isEditOrWrite ? 'modal-container--diff' : ''}`}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <span className="modal-meta">
            {event.tool_name && <span className="tag blue">{event.tool_name}</span>}
            {' '}
            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">
          <DetailContent event={event} />
        </div>
      </div>
    </div>
  );
}
