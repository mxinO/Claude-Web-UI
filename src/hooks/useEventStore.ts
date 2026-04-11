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
        // API returns newest-first; reverse for chronological order
        const chronological = [...fetched].reverse();
        setEvents(chronological);
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
      // Deduplicate by id
      if (prev.some(e => e.id === event.id)) {
        return prev;
      }
      const next = [...prev, event];
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
      // API returns newest-first; reverse for chronological order then prepend
      const chronological = [...fetched].reverse();
      setEvents(prev => {
        // Deduplicate
        const existingIds = new Set(prev.map(e => e.id));
        const newOnes = chronological.filter(e => !existingIds.has(e.id));
        return [...newOnes, ...prev];
      });
      if (fetched.length < PAGE_LIMIT) {
        setHasMore(false);
      }
    } catch {
      // ignore fetch errors
    }
  }, [session, events]);

  return {
    events,
    addEvent,
    session,
    setSession,
    loadOlderEvents,
    hasMore,
    reconnectSummary,
    setReconnectSummary,
  };
}
