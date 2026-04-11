import { useState } from 'react';
import type { TimelineEvent } from '../types';
import TimelineEventRow from './TimelineEvent';

interface SubagentTreeProps {
  agentId: string;
  agentType: string | null;
  events: TimelineEvent[];
  selectedId: number | null;
  onSelect: (event: TimelineEvent) => void;
}

export default function SubagentTree({
  agentId,
  agentType,
  events,
  selectedId,
  onSelect,
}: SubagentTreeProps) {
  const [collapsed, setCollapsed] = useState(false);

  const toolCount = events.filter((e) => e.event_type === 'tool_use').length;
  const isRunning = events.some((e) => e.status === 'running');
  const isDone = !isRunning;

  const label = agentType ?? agentId.slice(0, 8);
  const statusLabel = isDone ? 'done' : 'running';
  const chevron = collapsed ? '▶' : '▼';

  return (
    <div className="subagent-group">
      <div className="subagent-header" onClick={() => setCollapsed((c) => !c)}>
        <span>{chevron}</span>
        <span>Agent: {label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.8 }}>
          {toolCount} tools · {statusLabel}
        </span>
      </div>
      {!collapsed && (
        <div>
          {events.map((event) => (
            <TimelineEventRow
              key={event.id}
              event={event}
              selected={event.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
