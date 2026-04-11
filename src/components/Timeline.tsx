import { useEffect, useRef, useState, useCallback } from 'react';
import type { TimelineEvent, ReconnectSummary } from '../types';
import TimelineEventRow from './TimelineEvent';
import SubagentTree from './SubagentTree';
import ReconnectSummaryWidget from './ReconnectSummary';

interface TimelineProps {
  events: TimelineEvent[];
  selectedId: number | null;
  onSelect: (event: TimelineEvent) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  reconnectSummary: ReconnectSummary | null;
}

interface AgentGroup {
  type: 'agent';
  agentId: string;
  agentType: string | null;
  events: TimelineEvent[];
}

interface TopLevelEvent {
  type: 'event';
  event: TimelineEvent;
}

type RenderedItem = AgentGroup | TopLevelEvent;

function groupEvents(events: TimelineEvent[]): RenderedItem[] {
  const items: RenderedItem[] = [];
  const agentGroups = new Map<string, AgentGroup>();
  // Track order of agent groups for insertion
  const agentOrder: string[] = [];

  for (const event of events) {
    const agentId = event.agent_id;

    if (agentId) {
      // This event belongs to an agent group
      if (!agentGroups.has(agentId)) {
        const group: AgentGroup = {
          type: 'agent',
          agentId,
          agentType: event.agent_type,
          events: [],
        };
        agentGroups.set(agentId, group);
        agentOrder.push(agentId);
        items.push(group); // Insert placeholder (same reference, will be filled)
      }
      agentGroups.get(agentId)!.events.push(event);
    } else {
      // Top-level event
      items.push({ type: 'event', event });
    }
  }

  return items;
}

export default function Timeline({
  events,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  reconnectSummary,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const prevEventCountRef = useRef(0);

  // Auto-scroll to bottom when new events arrive, unless user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newCount = events.length;
    if (newCount === prevEventCountRef.current) return;
    prevEventCountRef.current = newCount;

    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  // Track user scroll position
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 80;
  }, []);

  // IntersectionObserver on sentinel at top → load more
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      { root: scrollRef.current, threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const items = groupEvents(events);

  return (
    <div
      className="timeline-events"
      ref={scrollRef}
      onScroll={onScroll}
    >
      {/* Sentinel at top for infinite scroll upward */}
      <div ref={sentinelRef} style={{ height: 1 }} />

      {hasMore && (
        <div className="loading-more" style={{ textAlign: 'center', padding: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
          Loading more…
        </div>
      )}

      {reconnectSummary && (
        <ReconnectSummaryWidget
          summary={reconnectSummary}
          onSelect={onSelect}
          events={events}
        />
      )}

      {events.length === 0 && (
        <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
          Waiting for events…
        </div>
      )}

      {items.map((item, idx) => {
        if (item.type === 'agent') {
          return (
            <SubagentTree
              key={`agent-${item.agentId}-${idx}`}
              agentId={item.agentId}
              agentType={item.agentType}
              events={item.events}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          );
        }
        return (
          <TimelineEventRow
            key={item.event.id}
            event={item.event}
            selected={item.event.id === selectedId}
            onSelect={onSelect}
          />
        );
      })}

      {/* Bottom anchor for auto-scroll */}
      <div ref={bottomRef} />
    </div>
  );
}
