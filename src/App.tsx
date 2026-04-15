import { useState, useCallback, useEffect, useRef } from 'react';
import Header from './components/Header';
import ChatMessage from './components/ChatMessage';
import DetailModal from './components/DetailModal';
import InputBox from './components/InputBox';
import ReconnectSummaryWidget from './components/ReconnectSummary';
import ThinkingIndicator from './components/ThinkingIndicator';
import StreamingCard from './components/StreamingCard';
import BtwToast from './components/BtwToast';
import { useWebSocket } from './hooks/useWebSocket';
import type { QueuedMessage } from './hooks/useWebSocket';
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

export default function App() {
  const [modalEvent, setModalEvent] = useState<TimelineEvent | null>(null);
  const [btwData, setBtwData] = useState<{ question: string; response: string } | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const streamingTextRef = useRef<string | null>(null);
  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const [cancelledText, setCancelledText] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const { events, addEvent, removeLastUserMessage, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();

  const onQueueChange = useCallback((queue: QueuedMessage[]) => {
    setMessageQueue(queue);
  }, []);

  const onStreaming = useCallback((text: string) => {
    if (cancelledRef.current) return; // ignore streaming after cancel
    streamingTextRef.current = text;
    setStreamingText(text);
    setCancelledText(null);
  }, []);

  const onEvent = useCallback((event: TimelineEvent) => {
    if (event.event_type === 'assistant_message') {
      streamingTextRef.current = null;
      setStreamingText(null);
      setStreamingExpanded(false);
      cancelledRef.current = false;
      setCancelledText(null);
    }
    if (event.event_type === 'user_message') {
      // New turn — reset cancelled state
      cancelledRef.current = false;
      setCancelledText(null);
    }
    addEvent(event);
  }, [addEvent]);

  const { connected } = useWebSocket({ onEvent, onStreaming, onQueueChange, session, setSession });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const prevEventCountRef = useRef(0);

  // Listen for /btw responses
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.question && detail?.response) {
        setBtwData({ question: detail.question, response: detail.response });
      }
    };
    window.addEventListener('btw-response', handler);
    return () => window.removeEventListener('btw-response', handler);
  }, []);

  // Listen for interrupt (stop button)
  useEffect(() => {
    const handler = (e: Event) => {
      cancelledRef.current = true;
      const restoredText = (e as CustomEvent).detail?.restoredText;

      // Claude always restores the prompt on cancel — put text back in input
      if (restoredText) {
        window.dispatchEvent(new CustomEvent('insert-input-text', {
          detail: { text: restoredText }
        }));
        removeLastUserMessage();
      }

      // If there was streaming output, show cancelled card with partial response
      if (streamingTextRef.current) {
        setCancelledText(streamingTextRef.current);
      }

      streamingTextRef.current = null;
      setStreamingText(null);
      setStreamingExpanded(false);
    };
    window.addEventListener('claude-interrupted', handler);
    return () => window.removeEventListener('claude-interrupted', handler);
  }, [removeLastUserMessage]);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    const newCount = events.length;
    if (newCount === prevEventCountRef.current) return;
    prevEventCountRef.current = newCount;
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  // Also scroll when streaming card appears
  useEffect(() => {
    if (streamingText && !userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 80;
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadOlderEvents(); },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadOlderEvents]);

  const handleOpenDetail = useCallback((event: TimelineEvent) => setModalEvent(event), []);
  const handleCloseDetail = useCallback(() => setModalEvent(null), []);
  const handleReconnectSelect = useCallback((event: TimelineEvent) => setModalEvent(event), []);

  // Thinking state: last event is a RECENT user message AND no streaming yet AND not cancelled.
  // "Recent" = within 30s. Historical messages (from JSONL import on resume) are old and
  // should not trigger thinking dots.
  const isThinking = events.length > 0 && !streamingText && !cancelledRef.current && (() => {
    const last = events[events.length - 1];
    if (last.event_type !== 'user_message') return false;
    const age = Date.now() - new Date(last.timestamp).getTime();
    return age < 30_000;
  })();

  // Running state: thinking, streaming, or a tool is in progress (but not after cancel)
  const isRunning = !cancelledRef.current && (isThinking || !!streamingText || events.some(e => e.event_type === 'tool_running'));

  return (
    <div className="app">
      <Header session={session} connected={connected} />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          <div ref={sentinelRef} style={{ height: 1 }} />

          {hasMore && (
            <div className="chat-load-more">Loading older messages...</div>
          )}

          {reconnectSummary && (
            <ReconnectSummaryWidget
              summary={reconnectSummary}
              onSelect={handleReconnectSelect}
              events={events}
            />
          )}

          {events.length === 0 && (
            <div className="chat-empty">Waiting for messages...</div>
          )}

          {events.map((event) => (
            <ChatMessage key={event.id} event={event} onOpenDetail={handleOpenDetail} />
          ))}

          {/* Streaming: compact card showing work in progress */}
          {streamingText && (
            <StreamingCard
              text={streamingText}
              onExpand={() => setStreamingExpanded(true)}
            />
          )}

          {/* Cancelled: show what was captured before interruption */}
          {cancelledText && !streamingText && (
            <div className="chat-row chat-row--assistant">
              <div
                className="tool-card tool-card--cancelled"
                onClick={() => {
                  setStreamingExpanded(true);
                }}
                style={{ cursor: 'pointer' }}
              >
                <span className="tool-card-icon">⏹</span>
                <span className="tool-card-summary">Cancelled — click to see partial response</span>
              </div>
            </div>
          )}

          {/* Thinking dots — only before streaming starts */}
          {isThinking && <ThinkingIndicator />}

          {/* Queued messages */}
          {messageQueue.map((msg) => (
            <div key={msg.id} className="chat-row chat-row--user">
              <div className="queued-message">
                <div className="queued-badge">Queued</div>
                <div className="queued-text">{msg.text}</div>
                <div className="queued-actions">
                  <button
                    className="queued-btn queued-btn--edit"
                    title="Edit — put back in input"
                    onClick={async () => {
                      await fetch(`/api/queue/${msg.id}`, { method: 'DELETE' });
                      window.dispatchEvent(new CustomEvent('insert-input-text', {
                        detail: { text: msg.text }
                      }));
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="queued-btn queued-btn--cancel"
                    title="Cancel — remove from queue"
                    onClick={() => fetch(`/api/queue/${msg.id}`, { method: 'DELETE' })}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      <InputBox isRunning={isRunning} />

      {/* Detail modal for tool calls */}
      {modalEvent && (
        <DetailModal event={modalEvent} onClose={handleCloseDetail} />
      )}

      {/* Streaming expanded popup */}
      {streamingExpanded && (streamingText || cancelledText) && (
        <div className="modal-overlay" onClick={() => setStreamingExpanded(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{cancelledText && !streamingText ? 'Cancelled (partial response)' : 'Responding...'}</span>
              <button className="modal-close" onClick={() => setStreamingExpanded(false)}>×</button>
            </div>
            <div className="modal-body">
              <pre className="streaming-expanded-text">{streamingText || cancelledText}</pre>
            </div>
          </div>
        </div>
      )}

      {/* /btw side question toast */}
      {btwData && (
        <BtwToast
          question={btwData.question}
          response={btwData.response}
          onClose={() => setBtwData(null)}
        />
      )}
    </div>
  );
}
