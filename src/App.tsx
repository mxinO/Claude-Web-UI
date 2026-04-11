import { useState, useCallback, useEffect, useRef } from 'react';
import Header from './components/Header';
import ChatMessage from './components/ChatMessage';
import DetailModal from './components/DetailModal';
import InputBox from './components/InputBox';
import ReconnectSummaryWidget from './components/ReconnectSummary';
import ThinkingIndicator from './components/ThinkingIndicator';
import { MarkdownView } from './components/MarkdownView';
import { useWebSocket } from './hooks/useWebSocket';
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

export default function App() {
  const [modalEvent, setModalEvent] = useState<TimelineEvent | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const { events, addEvent, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();

  const onStreaming = useCallback((text: string) => {
    setStreamingText(text);
  }, []);

  const onStreamingDone = useCallback(() => {
    setStreamingText(null);
  }, []);

  // Also clear streaming when we get an assistant_message event (the final response)
  const onEvent = useCallback((event: TimelineEvent) => {
    if (event.event_type === 'assistant_message') {
      setStreamingText(null);
    }
    addEvent(event);
  }, [addEvent]);

  const { connected } = useWebSocket({ onEvent, onStreaming, onStreamingDone, session, setSession });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const prevEventCountRef = useRef(0);
  const prevStreamingRef = useRef<string | null>(null);

  // Auto-scroll to bottom on new events or streaming updates
  useEffect(() => {
    const newCount = events.length;
    const streamChanged = streamingText !== prevStreamingRef.current;
    prevStreamingRef.current = streamingText;

    if (newCount === prevEventCountRef.current && !streamChanged) return;
    prevEventCountRef.current = newCount;

    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, streamingText]);

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

  // Determine if we're waiting for a response (thinking state)
  const isThinking = events.length > 0 && !streamingText && (() => {
    const last = events[events.length - 1];
    return last.event_type === 'user_message' || last.event_type === 'human';
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

          {/* Streaming partial response */}
          {streamingText && (
            <div className="chat-message assistant">
              <div className="message-bubble assistant-bubble streaming-bubble">
                <MarkdownView content={streamingText} />
              </div>
            </div>
          )}

          {/* Thinking dots — only show when waiting and not yet streaming */}
          {isThinking && <ThinkingIndicator />}

          <div ref={bottomRef} />
        </div>
      </div>

      <InputBox />

      {modalEvent && (
        <DetailModal event={modalEvent} onClose={handleCloseDetail} />
      )}
    </div>
  );
}
