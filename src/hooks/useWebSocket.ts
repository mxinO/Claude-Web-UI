import { useEffect, useRef, useState, useCallback } from 'react';
import type { Session, TimelineEvent } from '../types';

interface UseWebSocketOptions {
  onEvent: (event: TimelineEvent) => void;
  session: Session | null;
  setSession: (session: Session) => void;
}

export function useWebSocket({ onEvent, session, setSession }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastEventId = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (session?.id) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          session_id: session.id,
          last_event_id: lastEventId.current,
        }));
      }
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'event' && data.event) {
          const event = data.event as TimelineEvent;
          lastEventId.current = Math.max(lastEventId.current, event.id);
          onEventRef.current(event);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      const delay = 1000 + Math.random() * 4000;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, [session?.id]);

  // Fetch latest session on mount, then connect
  useEffect(() => {
    fetch('/api/sessions/latest')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setSession(s); })
      .catch(() => {});

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []); // eslint-disable-line

  // Re-subscribe when session changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && session?.id) {
      wsRef.current.send(JSON.stringify({
        type: 'subscribe',
        session_id: session.id,
        last_event_id: lastEventId.current,
      }));
    }
  }, [session?.id]);

  return { connected };
}
