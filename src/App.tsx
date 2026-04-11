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
  // Track the event ID that "replaces" streaming — we hide it briefly to avoid the jump
  const [hiddenEventId, setHiddenEventId] = useState<number | null>(null);
  const { events, addEvent, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();

  const onStreaming = useCallback((text: string) => {
    setStreamingText(text);
  }, []);

  const onStreamingDone = useCallback(() => {
    // Don't clear streaming here — let the assistant_message event handle it
  }, []);

  const onEvent = useCallback((event: TimelineEvent) => {
    if (event.event_type === 'assistant_message') {
      if (streamingText) {
        // Streaming was active — smoothly transition:
        // 1. Update streaming bubble to show the final text
        // 2. Hide the real event briefly
        // 3. After a short delay, clear streaming and show the real event
        setStreamingText(event.message_text || '');
        setHiddenEventId(event.id);
        addEvent(event);
        // After a brief moment, swap from streaming to real event
        setTimeout(() => {
          setStreamingText(null);
          setHiddenEventId(null);
        }, 150);
        return;
      }
    }
    addEvent(event);
  }, [addEvent, streamingText]);

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

          {events.map((event) => {
            // Hide the event that's being replaced by streaming (during transition)
            if (event.id === hiddenEventId) return null;
            return (
              <ChatMessage key={event.id} event={event} onOpenDetail={handleOpenDetail} />
            );
          })}

          {/* Streaming partial response — replaces thinking dots */}
          {streamingText && (
            <div className="chat-message assistant">
              <div className="message-bubble assistant-bubble">
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
