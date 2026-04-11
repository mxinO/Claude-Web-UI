import { TimelineEvent } from '../types';
import { DiffViewer, detectLanguage } from './DiffViewer';
import { MarkdownView } from './MarkdownView';
import { BashOutput } from './BashOutput';

interface Props {
  event: TimelineEvent | null;
}

function getTitle(event: TimelineEvent): string {
  switch (event.event_type) {
    case 'user_prompt': return 'User Prompt';
    case 'assistant_message': return 'Assistant Message';
    case 'tool_use': return `Tool: ${event.tool_name || 'unknown'}`;
    case 'permission': return 'Permission Request';
    case 'agent_stop': return 'Agent Stop';
    default: return event.event_type;
  }
}

function parseToolInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function EditDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.path as string) || '';
  const oldString = (input.old_string as string) ?? '';
  const newString = (input.new_string as string) ?? '';
  const language = detectLanguage(filePath);

  if (event.file_before != null) {
    const modified = event.file_before.replace(oldString, newString);
    return (
      <DiffViewer
        original={event.file_before}
        modified={modified}
        language={language}
        fileName={filePath}
      />
    );
  }

  return (
    <DiffViewer
      original={oldString}
      modified={newString}
      language={language}
      fileName={filePath}
    />
  );
}

function WriteDiff({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  const filePath = (input.path as string) || '';
  const content = (input.content as string) ?? '';
  const language = detectLanguage(filePath);

  return (
    <DiffViewer
      original={event.file_before ?? ''}
      modified={content}
      language={language}
      fileName={filePath}
    />
  );
}

function PermissionInfo({ event }: { event: TimelineEvent }) {
  const input = parseToolInput(event.tool_input);
  return (
    <div className="permission-info">
      <div><strong>Tool:</strong> {event.tool_name}</div>
      <div><strong>Status:</strong> {event.status}</div>
      <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

function DetailContent({ event }: { event: TimelineEvent }) {
  switch (event.event_type) {
    case 'user_prompt':
    case 'assistant_message':
      return <MarkdownView content={event.message_text ?? ''} />;

    case 'tool_use': {
      const toolName = event.tool_name?.toLowerCase() ?? '';

      if (toolName === 'edit') {
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

      // Default tool_use: JSON dump
      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(
            {
              tool_name: event.tool_name,
              tool_input: parseToolInput(event.tool_input),
              tool_response: event.tool_response,
              status: event.status,
            },
            null,
            2
          )}
        </pre>
      );
    }

    case 'permission':
      return <PermissionInfo event={event} />;

    case 'agent_stop':
      return <MarkdownView content={event.message_text ?? ''} />;

    default:
      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(event, null, 2)}
        </pre>
      );
  }
}

export function DetailPanel({ event }: Props) {
  if (!event) {
    return (
      <div className="detail-panel detail-panel--empty">
        <span>Select an event to view details</span>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <div className="detail-header">{getTitle(event)}</div>
      <div className="detail-body">
        <DetailContent event={event} />
      </div>
    </div>
  );
}
