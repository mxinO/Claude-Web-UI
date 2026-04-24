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
  const probeWsRef = useRef<WebSocket | null>(null);
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
      } else {
        // Session wasn't ready on initial mount (e.g. page loaded before the
        // first SessionStart hook fired). Retry now that the server is reachable.
        fetch('/api/sessions/latest')
          .then(r => r.ok ? r.json() : null)
          .then(s => { if (s) setSession(s); })
          .catch(() => {});
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
        } else if (data.type === 'claude_dead') {
          // Auto-restart was skipped (cooldown or no session id). Surface it.
          window.dispatchEvent(new CustomEvent('claude-dead', { detail: data }));
        } else if (data.type === 'claude_restarting') {
          // Server is resuming Claude in the same session's cwd after a death.
          window.dispatchEvent(new CustomEvent('claude-restarting', { detail: data }));
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = (event) => {
      setConnected(false);
      wsRef.current = null;
      if (event.code === 4401) {
        // Auth failure on WS — retry once (cookie may still be valid after network blip),
        // then show auth-lost overlay if it fails again
        reconnectTimer.current = setTimeout(() => {
          const retryWs = new WebSocket(`${protocol}//${window.location.host}/ws`);
          probeWsRef.current = retryWs;
          retryWs.onopen = () => { probeWsRef.current = null; retryWs.close(); connect(); };
          retryWs.onclose = (e) => {
            probeWsRef.current = null;
            if (e.code === 4401) window.dispatchEvent(new CustomEvent('auth-lost'));
            else connect(); // different error, keep trying
          };
          retryWs.onerror = () => {}; // onclose will fire
        }, 1000);
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

    // Re-connect after auth recovery (token re-entered)
    const onAuthRestored = () => {
      clearTimeout(reconnectTimer.current);
      connect();
    };
    window.addEventListener('auth-restored', onAuthRestored);

    return () => {
      clearTimeout(reconnectTimer.current);
      window.removeEventListener('auth-restored', onAuthRestored);
      if (probeWsRef.current) {
        probeWsRef.current.onclose = null;
        probeWsRef.current.close();
        probeWsRef.current = null;
      }
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
