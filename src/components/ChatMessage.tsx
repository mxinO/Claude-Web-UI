import { useMemo } from 'react';
import type { TimelineEvent } from '../types';
import { MarkdownView } from './MarkdownView';
import PermissionBar from './PermissionBar';

interface ChatMessageProps {
  event: TimelineEvent;
  onOpenDetail: (event: TimelineEvent) => void;
}

/* ── Icon helpers ──────────────────────────────────────────────── */

function getToolIcon(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === 'edit' || name === 'write' || name === 'multiedit') return '\u270F\uFE0F';
  if (name === 'bash' || name === 'computer') return '\u2699\uFE0F';
  if (name === 'grep' || name === 'glob' || name === 'search') return '\uD83D\uDD0D';
  if (name === 'read') return '\uD83D\uDCC4';
  if (name === 'agent') return '\uD83D\uDD00';
  if (name === 'webfetch' || name === 'websearch') return '\uD83C\uDF10';
  return '\uD83D\uDD27';
}

/* ── Summary helpers ──────────────────────────────────────────── */

function parseJSON(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function getToolSummary(event: TimelineEvent): string {
  const name = (event.tool_name ?? 'unknown').toLowerCase();
  const input = parseJSON(event.tool_input);

  if (name === 'edit' || name === 'write' || name === 'multiedit') {
    const filePath = (input.file_path ?? input.path ?? '') as string;
    const short = filePath.length > 50 ? '\u2026' + filePath.slice(-47) : filePath;
    return short || name;
  }

  if (name === 'bash') {
    const cmd = ((input.command ?? input.cmd ?? '') as string).split('\n')[0];
    return `$ ${cmd.slice(0, 80)}`;
  }

  if (name === 'read') {
    const filePath = (input.file_path ?? input.path ?? '') as string;
    const short = filePath.length > 50 ? '\u2026' + filePath.slice(-47) : filePath;
    return short || 'Read';
  }

  if (name === 'grep' || name === 'glob' || name === 'search') {
    const pattern = (input.pattern ?? input.query ?? '') as string;
    return pattern.slice(0, 70) || name;
  }

  return event.tool_name ?? 'Tool';
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toTimeString().slice(0, 8);
  } catch {
    return ts;
  }
}

/* ── Main component ───────────────────────────────────────────── */

export default function ChatMessage({ event, onOpenDetail }: ChatMessageProps) {
  const { event_type, tool_name } = event;
  const time = useMemo(() => formatTime(event.timestamp), [event.timestamp]);

  // ── User message ────────────────────────────────────────────
  if (event_type === 'user_message') {
    const text = event.message_text ?? '';
    // System-injected task note — render as a subtle inline note, not a user bubble
    if (text === '[Task finished]') {
      return (
        <div className="chat-row chat-row--system">
          <div className="chat-notification chat-notification--task">Task finished</div>
        </div>
      );
    }
    return (
      <div className="chat-row chat-row--user">
        <div className="chat-bubble chat-bubble--user">
          <div className="chat-bubble-text">{text}</div>
          <div className="chat-time">{time}</div>
        </div>
      </div>
    );
  }

  // ── Assistant message ───────────────────────────────────────
  if (event_type === 'assistant_message') {
    const text = event.message_text ?? '';
    if (!text.trim()) return null; // skip empty assistant messages
    return (
      <div className="chat-row chat-row--assistant">
        <div className="chat-bubble chat-bubble--assistant">
          <MarkdownView content={text} />
          <div className="chat-time">{time}</div>
        </div>
      </div>
    );
  }

  // ── Tool use / tool result ─────────────────────────────────
  if (event_type === 'tool_use' || event_type === 'tool_result' || event_type === 'tool_running') {
    const icon = getToolIcon(tool_name ?? '');
    const summary = getToolSummary(event);
    const isPending = event.status === 'pending' || event.status === 'running';
    const statusClass =
      event.status === 'error' ? 'tool-card--error' :
      event.status === 'success' ? 'tool-card--success' :
      isPending ? 'tool-card--running running' : '';

    return (
      <div className="chat-row chat-row--assistant">
        <div
          className={`tool-card ${statusClass}`}
          onClick={() => onOpenDetail(event)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenDetail(event); }}
        >
          <span className={`tool-card-icon${isPending ? ' tool-status-icon running' : ''}`}>{icon}</span>
          <span className="tool-card-summary">{summary}</span>
          <span className="tool-card-time">{time}</span>
          {event.status === 'success' && <span className="tool-card-check" style={{ color: 'var(--green)', flexShrink: 0 }}>✓</span>}
        </div>
      </div>
    );
  }

  // ── Permission request ─────────────────────────────────────
  if (event_type === 'permission' || event_type === 'permission_request') {
    const input = parseJSON(event.tool_input);
    const tn = (input.tool_name as string) ?? tool_name ?? 'unknown';
    const isPending = event.status === 'pending';

    // Build a descriptive summary based on tool type
    let detail = '';
    const tnLower = tn.toLowerCase();
    if (tnLower === 'write') {
      const fp = (input.file_path as string) || '';
      const shortPath = fp.length > 40 ? '...' + fp.slice(-37) : fp;
      const contentLen = ((input.content as string) || '').split('\n').length;
      detail = `${shortPath} (${contentLen} lines)`;
    } else if (tnLower === 'edit') {
      const fp = (input.file_path as string) || '';
      const shortPath = fp.length > 40 ? '...' + fp.slice(-37) : fp;
      detail = shortPath;
    } else if (tnLower === 'bash') {
      detail = `$ ${((input.command as string) || '').slice(0, 60)}`;
    }

    return (
      <div className="chat-row chat-row--assistant">
        <div
          className="tool-card tool-card--permission"
          onClick={() => onOpenDetail(event)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenDetail(event); }}
        >
          <span className="tool-card-icon">{isPending ? '\uD83D\uDD12' : event.status === 'allowed' ? '\u2705' : event.status === 'denied' ? '\u274C' : '\uD83D\uDD13'}</span>
          <span className="tool-card-summary">
            Permission: {tn}{detail ? ` — ${detail}` : ''}
            {!isPending && (
              <span style={{ marginLeft: 8, fontSize: 11, color: event.status === 'allowed' ? 'var(--green)' : event.status === 'denied' ? 'var(--red)' : 'var(--text-secondary)' }}>
                ({event.status})
              </span>
            )}
          </span>
          <span className="tool-card-time">{time}</span>
        </div>
        {isPending && <PermissionBar eventId={event.id} />}
      </div>
    );
  }

  // ── Subagent start/stop ────────────────────────────────────
  if (event_type === 'agent_start' || event_type === 'subagent_start') {
    const label = event.agent_type ?? event.agent_id?.slice(0, 8) ?? 'agent';
    return (
      <div className="chat-row chat-row--system">
        <div className="chat-badge chat-badge--agent">
          {'\uD83D\uDD00'} Agent started: {label}
          <span className="chat-time">{time}</span>
        </div>
      </div>
    );
  }

  if (event_type === 'agent_stop' || event_type === 'subagent_stop') {
    const label = event.agent_type ?? event.agent_id?.slice(0, 8) ?? 'agent';
    return (
      <div className="chat-row chat-row--system">
        <div
          className="chat-badge chat-badge--agent chat-badge--clickable"
          onClick={() => onOpenDetail(event)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenDetail(event); }}
        >
          {'\u23F9'} Agent finished: {label}
          <span className="chat-time">{time}</span>
        </div>
      </div>
    );
  }

  // ── Task created/completed ─────────────────────────────────
  if (event_type === 'task_created') {
    return (
      <div className="chat-row chat-row--system">
        <div className="chat-badge">{'\uD83D\uDCCB'} Task created <span className="chat-time">{time}</span></div>
      </div>
    );
  }

  if (event_type === 'task_completed') {
    return (
      <div className="chat-row chat-row--system">
        <div className="chat-badge chat-badge--success">{'\u2705'} Task completed <span className="chat-time">{time}</span></div>
      </div>
    );
  }

  // ── Notification ───────────────────────────────────────────
  if (event_type === 'notification') {
    return (
      <div className="chat-row chat-row--system">
        <div className="chat-notification">{event.message_text ?? 'Notification'}</div>
      </div>
    );
  }

  // ── Fallback ───────────────────────────────────────────────
  return (
    <div className="chat-row chat-row--system">
      <div className="chat-badge">{event_type} <span className="chat-time">{time}</span></div>
    </div>
  );
}
