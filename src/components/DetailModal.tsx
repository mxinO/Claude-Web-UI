import { useEffect, useCallback, lazy, Suspense } from 'react';
import type { TimelineEvent } from '../types';
import { MarkdownView } from './MarkdownView';
import { BashOutput } from './BashOutput';
import { detectLanguage } from '../lib/detectLanguage';

// Lazy-load DiffViewer so Monaco (~5 MB) only loads when the modal opens
const LazyDiffViewer = lazy(() =>
  import('./DiffViewer').then((m) => ({ default: m.DiffViewer }))
);
interface DetailModalProps {
  event: TimelineEvent;
  onClose: () => void;
}

/* ── Helpers ───────────────────────────────────────────────────── */

function parseToolInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function getTitle(event: TimelineEvent): string {
  switch (event.event_type) {
    case 'user_message':
    case 'user_prompt': return 'User Message';
    case 'assistant_message': return 'Assistant Message';
    case 'tool_use':
    case 'tool_result': return `Tool: ${event.tool_name || 'unknown'}`;
    case 'permission':
    case 'permission_request': return 'Permission Request';
    case 'agent_stop':
    case 'subagent_stop': return 'Subagent Result';
    default: return event.event_type;
  }
}

/* ── Edit diff (uses Monaco) ──────────────────────────────────── */

function EditDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.file_path as string) || '';
  const oldString = (input.old_string as string) ?? '';
  const newString = (input.new_string as string) ?? '';

  const language = detectLanguage(filePath);

  if (event.file_before != null) {
    const modified = event.file_before.replace(oldString, newString);
    return (
      <Suspense fallback={<div className="modal-loading">Loading diff editor...</div>}>
        <LazyDiffViewer original={event.file_before} modified={modified} language={language} fileName={filePath} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<div className="modal-loading">Loading diff editor...</div>}>
      <LazyDiffViewer original={oldString} modified={newString} language={language} fileName={filePath} />
    </Suspense>
  );
}

function WriteDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.file_path as string) || '';
  const content = (input.content as string) ?? '';
  const language = detectLanguage(filePath);

  return (
    <Suspense fallback={<div className="modal-loading">Loading diff editor...</div>}>
      <LazyDiffViewer original={event.file_before ?? ''} modified={content} language={language} fileName={filePath} />
    </Suspense>
  );
}

/* ── Detail content router ────────────────────────────────────── */

function DetailContent({ event }: { event: TimelineEvent }) {
  switch (event.event_type) {
    case 'user_message':
    case 'user_prompt':
    case 'assistant_message':
      return <MarkdownView content={event.message_text ?? ''} />;

    case 'tool_use':
    case 'tool_result': {
      const toolName = event.tool_name?.toLowerCase() ?? '';

      if (toolName === 'edit' || toolName === 'multiedit') {
        return <EditDiff event={event} />;
      }
      if (toolName === 'write') {
        return <WriteDiff event={event} />;
      }
      if (toolName === 'bash') {
        const input = parseToolInput(event.tool_input);
        const command = (input.command as string) ?? '';
        const response = event.tool_response ?? '';
        return <BashOutput command={command} output={response} />;
      }

      // Generic tool: JSON dump
      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
          {JSON.stringify(
            {
              tool_name: event.tool_name,
              tool_input: parseToolInput(event.tool_input),
              tool_response: event.tool_response,
              status: event.status,
            },
            null,
            2,
          )}
        </pre>
      );
    }

    case 'permission':
    case 'permission_request': {
      const input = parseToolInput(event.tool_input);
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

    case 'agent_stop':
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
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const title = getTitle(event);
  const isEditOrWrite =
    (event.event_type === 'tool_use' || event.event_type === 'tool_result') &&
    ['edit', 'write', 'multiedit'].includes((event.tool_name ?? '').toLowerCase());

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
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
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="modal-body">
          <DetailContent event={event} />
        </div>
      </div>
    </div>
  );
}
