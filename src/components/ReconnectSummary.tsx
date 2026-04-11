import { useState } from 'react';
import type { TimelineEvent, ReconnectSummary } from '../types';

interface ReconnectSummaryWidgetProps {
  summary: ReconnectSummary;
  onSelect: (event: TimelineEvent) => void;
  events: TimelineEvent[];
}

function findEvent(events: TimelineEvent[], eventId: number): TimelineEvent | undefined {
  return events.find((e) => e.id === eventId);
}

export default function ReconnectSummaryWidget({
  summary,
  onSelect,
  events,
}: ReconnectSummaryWidgetProps) {
  const [editsOpen, setEditsOpen] = useState(true);
  const [commandsOpen, setCommandsOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);

  return (
    <div className="reconnect-summary">
      <div className="summary-title">
        ↩ Reconnected — {summary.total_events} events while away
      </div>

      <div className="summary-stats">
        {summary.tasks_completed > 0 && (
          <span>
            <span className="stat-value">{summary.tasks_completed}</span> completed
          </span>
        )}
        {summary.tasks_in_progress > 0 && (
          <span>
            <span className="stat-value">{summary.tasks_in_progress}</span> in progress
          </span>
        )}
      </div>

      {summary.last_message && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--text-secondary)',
            fontStyle: 'italic',
          }}
        >
          Last: {summary.last_message.slice(0, 120)}
        </div>
      )}

      {summary.edits.length > 0 && (
        <div className="summary-section">
          <div
            className="summary-section-header"
            onClick={() => setEditsOpen((o) => !o)}
          >
            {editsOpen ? '▼' : '▶'} Edits ({summary.edits.length})
          </div>
          {editsOpen &&
            summary.edits.map((edit) => {
              const ev = findEvent(events, edit.event_id);
              const shortPath =
                edit.file_path.length > 40
                  ? '…' + edit.file_path.slice(-37)
                  : edit.file_path;
              return (
                <div key={edit.event_id} className="summary-item">
                  <span title={edit.file_path}>{shortPath}</span>
                  {' '}
                  <span style={{ color: 'var(--green)' }}>+{edit.additions}</span>{' '}
                  <span style={{ color: 'var(--red)' }}>-{edit.deletions}</span>
                  {edit.is_new && (
                    <span style={{ marginLeft: 4, color: 'var(--yellow)', fontSize: 10 }}>
                      NEW
                    </span>
                  )}
                  {ev && (
                    <button
                      className="view-link"
                      style={{
                        marginLeft: 8,
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-accent)',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: 0,
                      }}
                      onClick={() => onSelect(ev)}
                    >
                      view
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {summary.commands.length > 0 && (
        <div className="summary-section">
          <div
            className="summary-section-header"
            onClick={() => setCommandsOpen((o) => !o)}
          >
            {commandsOpen ? '▼' : '▶'} Commands ({summary.commands.length})
          </div>
          {commandsOpen &&
            summary.commands.map((cmd) => {
              const ev = findEvent(events, cmd.event_id);
              const shortCmd = cmd.command.split('\n')[0].slice(0, 60);
              return (
                <div key={cmd.event_id} className="summary-item">
                  <span
                    style={{
                      color:
                        cmd.status === 'error' ? 'var(--red)' : 'var(--text-secondary)',
                    }}
                  >
                    $ {shortCmd}
                  </span>
                  {ev && (
                    <button
                      className="view-link"
                      style={{
                        marginLeft: 8,
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-accent)',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: 0,
                      }}
                      onClick={() => onSelect(ev)}
                    >
                      view
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {summary.agents.length > 0 && (
        <div className="summary-section">
          <div
            className="summary-section-header"
            onClick={() => setAgentsOpen((o) => !o)}
          >
            {agentsOpen ? '▼' : '▶'} Agents ({summary.agents.length})
          </div>
          {agentsOpen &&
            summary.agents.map((agent) => (
              <div key={agent.agent_id} className="summary-item">
                <span>{agent.agent_type ?? agent.agent_id.slice(0, 8)}</span>
                {' — '}
                <span>{agent.tool_count} tools</span>
                {' · '}
                <span
                  style={{
                    color:
                      agent.status === 'done'
                        ? 'var(--green)'
                        : 'var(--yellow)',
                  }}
                >
                  {agent.status}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
