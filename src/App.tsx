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
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

export default function App() {
  const [modalEvent, setModalEvent] = useState<TimelineEvent | null>(null);
  const [btwData, setBtwData] = useState<{ question: string; response: string } | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const { events, addEvent, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();

  const onStreaming = useCallback((text: string) => {
    setStreamingText(text);
  }, []);

  const onEvent = useCallback((event: TimelineEvent) => {
    if (event.event_type === 'assistant_message') {
      // Clear streaming — the final message takes over
      setStreamingText(null);
      setStreamingExpanded(false);
    }
    addEvent(event);
  }, [addEvent]);

  const { connected } = useWebSocket({ onEvent, onStreaming, session, setSession });

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

  // Thinking state: last event is user message AND no streaming yet
  const isThinking = events.length > 0 && !streamingText && (() => {
    const last = events[events.length - 1];
    return last.event_type === 'user_message';
  })();

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

          {/* Thinking dots — only before streaming starts */}
          {isThinking && <ThinkingIndicator />}

          <div ref={bottomRef} />
        </div>
      </div>

      <InputBox />

      {/* Detail modal for tool calls */}
      {modalEvent && (
        <DetailModal event={modalEvent} onClose={handleCloseDetail} />
      )}

      {/* Streaming expanded popup */}
      {streamingExpanded && streamingText && (
        <div className="modal-overlay" onClick={() => setStreamingExpanded(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Responding...</span>
              <button className="modal-close" onClick={() => setStreamingExpanded(false)}>×</button>
            </div>
            <div className="modal-body">
              <pre className="streaming-expanded-text">{streamingText}</pre>
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
