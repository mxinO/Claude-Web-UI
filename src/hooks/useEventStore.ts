import { useState, useCallback } from 'react';
import { Session, TimelineEvent, ReconnectSummary } from '../types';

const MAX_EVENTS = 500;
const PAGE_LIMIT = 50;

interface UseEventStoreReturn {
  events: TimelineEvent[];
  addEvent: (event: TimelineEvent) => void;
  session: Session | null;
  setSession: (session: Session) => void;
  loadOlderEvents: () => Promise<void>;
  hasMore: boolean;
  reconnectSummary: ReconnectSummary | null;
  setReconnectSummary: (summary: ReconnectSummary | null) => void;
  removeLastUserMessage: () => void;
}

export function useEventStore(): UseEventStoreReturn {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [session, setSessionState] = useState<Session | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reconnectSummary, setReconnectSummary] = useState<ReconnectSummary | null>(null);

  const setSession = useCallback((newSession: Session) => {
    setSessionState(newSession);
    setEvents([]);
    setHasMore(false);

    // Fetch initial events for the session
    fetch(`/api/events?session_id=${encodeURIComponent(newSession.id)}&limit=${PAGE_LIMIT}`)
      .then(res => res.ok ? res.json() : [])
      .then((fetched: TimelineEvent[]) => {
        // API returns chronological order (ASC by timestamp, id as tiebreaker)
        setEvents(fetched);
        if (fetched.length === PAGE_LIMIT) {
          setHasMore(true);
        }
      })
      .catch(() => {
        // leave events empty on error
      });
  }, []);

  const addEvent = useCallback((event: TimelineEvent) => {
    setEvents(prev => {
      // tool_running (id=-1) is a transient indicator — show it but replace when real event arrives
      if (event.event_type === 'tool_running') {
        // Remove any existing tool_running for the same tool_name, then append
        const filtered = prev.filter(e => e.event_type !== 'tool_running');
        return [...filtered, event];
      }

      // Insert by chronological timestamp, not arrival order. Server captures
      // intermediate assistant text by tailing the JSONL transcript, which can
      // arrive AFTER the tool_result that chronologically came later — sorting
      // by timestamp keeps the UI in conversation order regardless. id is the
      // tiebreaker for events with identical timestamps.
      const insertSorted = (arr: TimelineEvent[]): TimelineEvent[] => {
        const ts = event.timestamp || '';
        let lo = 0, hi = arr.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const midTs = arr[mid].timestamp || '';
          // Skip the transient tool_running (it has no real timestamp); always
          // keep it at the end so sorted insertion goes before it.
          if (arr[mid].event_type === 'tool_running') { hi = mid; continue; }
          if (midTs < ts || (midTs === ts && arr[mid].id < event.id)) lo = mid + 1;
          else hi = mid;
        }
        return [...arr.slice(0, lo), event, ...arr.slice(lo)];
      };

      // When a real tool_result arrives, remove the transient tool_running
      if (event.event_type === 'tool_result' || (event.event_type === 'tool_use' && event.status === 'completed')) {
        const filtered = prev.filter(e => e.event_type !== 'tool_running');
        if (filtered.some(e => e.id === event.id)) return filtered;
        const next = insertSorted(filtered);
        if (next.length > MAX_EVENTS) {
          setHasMore(true);
          return next.slice(next.length - MAX_EVENTS);
        }
        return next;
      }

      // Deduplicate by id
      if (prev.some(e => e.id === event.id)) {
        return prev;
      }
      const next = insertSorted(prev);
      if (next.length > MAX_EVENTS) {
        setHasMore(true);
        return next.slice(next.length - MAX_EVENTS);
      }
      return next;
    });
  }, []);

  const loadOlderEvents = useCallback(async () => {
    if (!session) return;
    const oldestId = events.length > 0 ? events[0].id : undefined;
    const url = oldestId !== undefined
      ? `/api/events?session_id=${encodeURIComponent(session.id)}&before=${oldestId}&limit=${PAGE_LIMIT}`
      : `/api/events?session_id=${encodeURIComponent(session.id)}&limit=${PAGE_LIMIT}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const fetched: TimelineEvent[] = await res.json();
      if (fetched.length === 0) {
        setHasMore(false);
        return;
      }
      // API returns chronological (ASC), prepend older events
      setEvents(prev => {
        const existingIds = new Set(prev.map(e => e.id));
        const newOnes = fetched.filter(e => !existingIds.has(e.id));
        return [...newOnes, ...prev];
      });
      if (fetched.length < PAGE_LIMIT) {
        setHasMore(false);
      }
    } catch {
      // ignore fetch errors
    }
  }, [session, events]);

  const removeLastUserMessage = useCallback(() => {
    setEvents(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].event_type === 'user_message') {
          return [...prev.slice(0, i), ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
  }, []);

  return {
    events,
    addEvent,
    removeLastUserMessage,
    session,
    setSession,
    loadOlderEvents,
    hasMore,
    reconnectSummary,
    setReconnectSummary,
  };
}
