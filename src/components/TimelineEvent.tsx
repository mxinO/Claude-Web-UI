import type { TimelineEvent as TimelineEventType } from '../types';
import PermissionBar from './PermissionBar';

interface TimelineEventProps {
  event: TimelineEventType;
  selected: boolean;
  onSelect: (event: TimelineEventType) => void;
}

function getIcon(eventType: string, toolName?: string | null): string {
  switch (eventType) {
    case 'user_message':
    case 'human':
      return '👤';
    case 'assistant_message':
    case 'assistant':
      return '🤖';
    case 'tool_use':
    case 'tool_result':
      return getToolIcon(toolName ?? '');
    case 'permission':
    case 'permission_request':
      return '🔒';
    case 'agent_start':
    case 'subagent_start':
      return '🔀';
    case 'agent_stop':
    case 'subagent_stop':
      return '⏹';
    case 'task_created':
      return '📋';
    case 'task_completed':
      return '✅';
    default:
      return '•';
  }
}

function getToolIcon(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === 'edit' || name === 'write' || name === 'multiedit') return '✏️';
  if (name === 'bash' || name === 'computer') return '⚙️';
  if (name === 'grep' || name === 'glob' || name === 'search') return '🔍';
  if (name === 'read') return '📄';
  if (name === 'agent') return '🔀';
  if (name === 'webfetch' || name === 'websearch') return '🌐';
  return '🔧';
}

function getSummary(event: TimelineEventType): { title: string; subtitle?: string } {
  const { event_type, tool_name, tool_input, message_text } = event;

  if (event_type === 'user_message' || event_type === 'human') {
    const text = message_text ?? '';
    return { title: text.slice(0, 120) || '(empty)' };
  }

  if (event_type === 'assistant_message' || event_type === 'assistant') {
    const text = message_text ?? '';
    return { title: text.slice(0, 120) || '(empty)' };
  }

  if (event_type === 'permission' || event_type === 'permission_request') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(tool_input ?? '{}'); } catch { /* ignore */ }
    const tn = (parsed.tool_name as string) ?? tool_name ?? 'unknown';
    return { title: `Permission: ${tn}` };
  }

  if (event_type === 'agent_start' || event_type === 'subagent_start') {
    return { title: `Agent started` };
  }

  if (event_type === 'agent_stop' || event_type === 'subagent_stop') {
    return { title: `Agent finished` };
  }

  if (event_type === 'task_created') {
    return { title: 'Task created' };
  }

  if (event_type === 'task_completed') {
    return { title: 'Task completed' };
  }

  if (event_type === 'tool_use' || event_type === 'tool_result') {
    const name = tool_name ?? 'unknown';
    const nameLower = name.toLowerCase();

    if (nameLower === 'edit' || nameLower === 'write' || nameLower === 'multiedit') {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tool_input ?? '{}'); } catch { /* ignore */ }
      const filePath = (parsed.path ?? parsed.file_path ?? '') as string;
      const shortPath = filePath.length > 40
        ? '…' + filePath.slice(-37)
        : filePath;
      let parsed2: Record<string, unknown> = {};
      try { parsed2 = JSON.parse(event.tool_response ?? '{}'); } catch { /* ignore */ }
      const additions = parsed2.additions as number | undefined;
      const deletions = parsed2.deletions as number | undefined;
      const subtitle = (additions !== undefined && deletions !== undefined)
        ? `+${additions} -${deletions}`
        : undefined;
      return { title: shortPath || name, subtitle };
    }

    if (nameLower === 'bash') {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tool_input ?? '{}'); } catch { /* ignore */ }
      const cmd = ((parsed.command ?? parsed.cmd ?? '') as string).split('\n')[0].slice(0, 100);
      return { title: `$ ${cmd}` };
    }

    if (nameLower === 'read') {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tool_input ?? '{}'); } catch { /* ignore */ }
      const filePath = (parsed.file_path ?? parsed.path ?? '') as string;
      const shortPath = filePath.length > 50 ? '…' + filePath.slice(-47) : filePath;
      return { title: shortPath || 'Read' };
    }

    if (nameLower === 'grep' || nameLower === 'glob' || nameLower === 'search') {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tool_input ?? '{}'); } catch { /* ignore */ }
      const pattern = (parsed.pattern ?? parsed.query ?? '') as string;
      return { title: pattern.slice(0, 80) || name };
    }

    // Generic tool
    return { title: name };
  }

  return { title: event_type };
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  } catch {
    return ts;
  }
}

export default function TimelineEvent({ event, selected, onSelect }: TimelineEventProps) {
  const icon = getIcon(event.event_type, event.tool_name);
  const { title, subtitle } = getSummary(event);
  const timestamp = formatTimestamp(event.timestamp);
  const isPendingPermission = (event.event_type === 'permission' || event.event_type === 'permission_request') && event.status === 'pending';

  const statusClass =
    event.status === 'error'
      ? 'status-error'
      : event.status === 'success'
      ? 'status-success'
      : event.status === 'running'
      ? 'status-running'
      : '';

  return (
    <>
      <div
        className={`timeline-event ${selected ? 'selected' : ''} ${statusClass}`}
        onClick={() => onSelect(event)}
      >
        <span className="event-icon">{icon}</span>
        <span className="event-content">
          <span className="event-title">{title}</span>
          {subtitle && <span className="event-subtitle">{subtitle}</span>}
        </span>
        <span className="event-timestamp">{timestamp}</span>
      </div>
      {isPendingPermission && <PermissionBar eventId={event.id} />}
    </>
  );
}
