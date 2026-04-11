import { useState, useCallback, useEffect, useRef } from 'react';
import Header from './components/Header';
import ChatMessage from './components/ChatMessage';
import DetailModal from './components/DetailModal';
import InputBox from './components/InputBox';
import ReconnectSummaryWidget from './components/ReconnectSummary';
import ThinkingIndicator from './components/ThinkingIndicator';
import { useWebSocket } from './hooks/useWebSocket';
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

export default function App() {
  const [modalEvent, setModalEvent] = useState<TimelineEvent | null>(null);
  const { events, addEvent, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();
  const { connected } = useWebSocket({ onEvent: addEvent, session, setSession });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const prevEventCountRef = useRef(0);

  // Auto-scroll to bottom on new events unless user scrolled up
  useEffect(() => {
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

  // IntersectionObserver for loading older events
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadOlderEvents();
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadOlderEvents]);

  const handleOpenDetail = useCallback((event: TimelineEvent) => {
    setModalEvent(event);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setModalEvent(null);
  }, []);

  // Dummy onSelect for ReconnectSummaryWidget (opens detail modal)
  const handleReconnectSelect = useCallback((event: TimelineEvent) => {
    setModalEvent(event);
  }, []);

  return (
    <div className="app">
      <Header session={session} connected={connected} />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {/* Sentinel for infinite scroll upward */}
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
            <ChatMessage
              key={event.id}
              event={event}
              onOpenDetail={handleOpenDetail}
            />
          ))}

          {events.length > 0 && (() => {
            const last = events[events.length - 1];
            return last.event_type === 'user_message' || last.event_type === 'human';
          })() && <ThinkingIndicator />}

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
