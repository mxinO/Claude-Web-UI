import { useEffect, useRef, useCallback } from 'react';
import { Session, TimelineEvent } from '../types';

interface UseWebSocketOptions {
  onEvent: (event: TimelineEvent) => void;
  session: Session | null;
  setSession: (session: Session) => void;
}

export function useWebSocket({ onEvent, session, setSession }: UseWebSocketOptions): { connected: boolean } {
  const connectedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const connectedStateRef = useRef(false);
  const mountedRef = useRef(true);

  // We use a forceUpdate pattern via ref to avoid infinite loops
  // but we expose connected via a ref-backed approach.
  // For simplicity, we track connected state and the caller can re-render via session changes.

  const connect = useCallback((sess: Session | null) => {
    if (!mountedRef.current) return;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const url = `ws://${window.location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect(sess);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      connectedRef.current = true;
      if (sess) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          session_id: sess.id,
          last_event_id: lastEventIdRef.current,
        }));
      }
    };

    ws.onmessage = (evt: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(evt.data as string);
        if (data.type === 'event') {
          const event: TimelineEvent = data.event;
          if (event.id > (lastEventIdRef.current ?? -1)) {
            lastEventIdRef.current = event.id;
          }
          onEvent(event);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      // error will be followed by close
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      connectedRef.current = false;
      wsRef.current = null;
      scheduleReconnect(sess);
    };
  }, [onEvent]);

  const scheduleReconnect = useCallback((sess: Session | null) => {
    if (!mountedRef.current) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    const delay = (1 + Math.random() * 9) * 1000; // 1-10s random
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connect(sess);
      }
    }, delay);
  }, [connect]);

  // Fetch latest session on mount
  useEffect(() => {
    mountedRef.current = true;

    fetch('/api/sessions/latest')
      .then(res => res.ok ? res.json() : null)
      .then((sess: Session | null) => {
        if (sess && mountedRef.current) {
          setSession(sess);
        }
      })
      .catch(() => {
        // no session found, connect anyway
        connect(null);
      });

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-subscribe when session changes
  useEffect(() => {
    if (!mountedRef.current) return;
    // Reset lastEventId when session changes
    lastEventIdRef.current = undefined;
    connect(session);
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected: connectedRef.current };
}
