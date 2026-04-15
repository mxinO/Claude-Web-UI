import { useEffect, useRef, useState, useCallback } from 'react';
import type { Session, TimelineEvent } from '../types';

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
}

interface UseWebSocketOptions {
  onEvent: (event: TimelineEvent) => void;
  onStreaming?: (text: string) => void;
  onStreamingDone?: () => void;
  onQueueChange?: (queue: QueuedMessage[]) => void;
  session: Session | null;
  setSession: (session: Session) => void;
}

export function useWebSocket({ onEvent, onStreaming, onStreamingDone, onQueueChange, session, setSession }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastEventId = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStreamingRef = useRef(onStreaming);
  onStreamingRef.current = onStreaming;
  const onStreamingDoneRef = useRef(onStreamingDone);
  onStreamingDoneRef.current = onStreamingDone;
  const queueRef = useRef<QueuedMessage[]>([]);
  const onQueueChangeRef = useRef(onQueueChange);
  onQueueChangeRef.current = onQueueChange;

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
        } else if (data.type === 'streaming' && data.text) {
          onStreamingRef.current?.(data.text);
        } else if (data.type === 'streaming_done') {
          onStreamingDoneRef.current?.();
        } else if (data.type === 'queue_add' && data.message) {
          queueRef.current = [...queueRef.current, data.message];
          onQueueChangeRef.current?.(queueRef.current);
        } else if (data.type === 'queue_remove' && data.id) {
          queueRef.current = queueRef.current.filter(m => m.id !== data.id);
          onQueueChangeRef.current?.(queueRef.current);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = (event) => {
      setConnected(false);
      wsRef.current = null;
      // Auth failure — redirect to login instead of reconnecting
      if (event.code === 4401) {
        window.location.reload();
        return;
      }
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

    // Load initial queue
    fetch('/api/queue')
      .then(r => r.ok ? r.json() : [])
      .then((q: QueuedMessage[]) => { queueRef.current = q; onQueueChangeRef.current?.(q); })
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
