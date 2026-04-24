import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Header from './components/Header';
import ChatMessage from './components/ChatMessage';
import DetailModal from './components/DetailModal';
import InputBox from './components/InputBox';
import FileExplorer from './components/FileExplorer';
import ReconnectSummaryWidget from './components/ReconnectSummary';
import ThinkingIndicator from './components/ThinkingIndicator';
import StreamingCard from './components/StreamingCard';
import BtwToast from './components/BtwToast';
import AuthOverlay from './components/AuthOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import type { QueuedMessage } from './hooks/useWebSocket';
import { useAuthRecovery } from './hooks/useAuthRecovery';
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

/** Extract file_path from a tool_result event's tool_input JSON */
function getEditFilePath(event: TimelineEvent): string | null {
  if (event.event_type !== 'tool_result') return null;
  const name = (event.tool_name ?? '').toLowerCase();
  if (name !== 'edit') return null;
  try {
    const input = JSON.parse(event.tool_input || '{}');
    return input.file_path || null;
  } catch { return null; }
}

export interface EditGroup {
  events: TimelineEvent[];
  filePath: string;
}

/** Check if an event is a tool call (tool_result or tool_running) */
function isToolEvent(event: TimelineEvent): boolean {
  return event.event_type === 'tool_result' || event.event_type === 'tool_running';
}

/** Group Edit tool_result events targeting the same file within a contiguous
 *  block of tool calls. Other tool events (Read, Bash, etc.) between edits
 *  don't break the grouping — only non-tool events (assistant_message,
 *  user_message, etc.) do. */
function groupEditEvents(events: TimelineEvent[]): Array<TimelineEvent | EditGroup> {
  const result: Array<TimelineEvent | EditGroup> = [];
  let i = 0;
  while (i < events.length) {
    // Find contiguous tool blocks
    if (!isToolEvent(events[i])) {
      result.push(events[i]);
      i++;
      continue;
    }

    // Scan the full tool block (until a non-tool event)
    let blockEnd = i;
    while (blockEnd < events.length && isToolEvent(events[blockEnd])) blockEnd++;

    // Collect Edit events per file within this block
    const editsByFile = new Map<string, TimelineEvent[]>();
    for (let j = i; j < blockEnd; j++) {
      const fp = getEditFilePath(events[j]);
      if (fp) {
        if (!editsByFile.has(fp)) editsByFile.set(fp, []);
        editsByFile.get(fp)!.push(events[j]);
      }
    }

    // Emit events in original order, replacing grouped edits with EditGroup
    const groupedFiles = new Set<string>();
    for (let j = i; j < blockEnd; j++) {
      const fp = getEditFilePath(events[j]);
      if (fp && editsByFile.has(fp)) {
        if (groupedFiles.has(fp)) continue; // already emitted as group
        groupedFiles.add(fp);
        const group = editsByFile.get(fp)!;
        if (group.length > 1) {
          result.push({ events: group, filePath: fp });
        } else {
          result.push(group[0]);
        }
      } else {
        result.push(events[j]);
      }
    }
    i = blockEnd;
  }
  return result;
}

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 260;

export default function App() {
  const [modalEvent, setModalEvent] = useState<TimelineEvent | null>(null);
  const [btwData, setBtwData] = useState<{ question: string; response: string } | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const streamingTextRef = useRef<string | null>(null);
  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const [cancelledText, setCancelledText] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('sidebar-open');
    return saved !== null ? saved === 'true' : true;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width');
    const n = parseInt(saved ?? '', 10);
    return Number.isNaN(n) ? SIDEBAR_DEFAULT : Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
  });
  const resizingRef = useRef(false);
  const { events, addEvent, removeLastUserMessage, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();

  const groupedEvents = useMemo(() => groupEditEvents(events), [events]);

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
    if (event.event_type === 'assistant_message' || event.event_type === 'stop') {
      streamingTextRef.current = null;
      setStreamingText(null);
      setStreamingExpanded(false);
      cancelledRef.current = false;
      setCancelledText(null);
      setWaitingForReply(false);
    }
    if (event.event_type === 'user_message') {
      // New turn — reset cancelled state
      cancelledRef.current = false;
      setCancelledText(null);
    }
    addEvent(event);
  }, [addEvent]);

  const { connected } = useWebSocket({ onEvent, onStreaming, onQueueChange, session, setSession });
  const { needsAuth } = useAuthRecovery();

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

  // Listen for ! bash command output
  const bashIdRef = useRef(-1000);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const id = bashIdRef.current--;
      addEvent({
        id,
        session_id: session?.id ?? '',
        timestamp: new Date().toISOString(),
        event_type: 'bash_output',
        agent_id: null,
        agent_type: null,
        tool_name: 'bash',
        tool_input: JSON.stringify({ command: detail.command, exitCode: detail.exitCode, killed: detail.killed }),
        tool_response: null,
        message_text: detail.output || '',
        status: detail.exitCode === 0 ? 'success' : 'error',
        file_before: null,
      });
    };
    window.addEventListener('bash-output', handler);
    return () => window.removeEventListener('bash-output', handler);
  }, [addEvent, session]);

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
    const prevCount = prevEventCountRef.current;
    if (newCount === prevCount) return;
    // Initial load (0 → N): always scroll instantly, reset scroll tracking
    if (prevCount === 0 && newCount > 0) {
      userScrolledUpRef.current = false;
      prevEventCountRef.current = newCount;
      // Use requestAnimationFrame so DOM has laid out the content
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
      return;
    }
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

  // Set waitingForReply when user sends a message and scroll to bottom
  useEffect(() => {
    const handler = () => {
      setWaitingForReply(true);
      userScrolledUpRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    };
    const scrollToBottom = () => {
      userScrolledUpRef.current = false;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    };
    const deadHandler = () => {
      alert('Claude Code tmux session died and auto-restart is on cooldown (or no session to resume). Restart the server to recover.');
    };
    const restartingHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { cwd?: string } | undefined;
      const cwd = detail?.cwd || 'last working directory';
      // Non-blocking toast-style notice reusing the btw-response popup
      window.dispatchEvent(new CustomEvent('btw-response', {
        detail: { question: 'Claude restart', response: `Claude died — resuming in ${cwd}…` }
      }));
    };
    window.addEventListener('claude-message-sent', handler);
    window.addEventListener('bash-output', scrollToBottom);
    window.addEventListener('claude-dead', deadHandler);
    window.addEventListener('claude-restarting', restartingHandler);
    return () => {
      window.removeEventListener('claude-message-sent', handler);
      window.removeEventListener('bash-output', scrollToBottom);
      window.removeEventListener('claude-dead', deadHandler);
      window.removeEventListener('claude-restarting', restartingHandler);
    };
  }, []);

  // Sidebar resize
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const newW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth(w => { localStorage.setItem('sidebar-width', String(w)); return w; });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(v => { const next = !v; localStorage.setItem('sidebar-open', String(next)); return next; });
  }, []);

  const handleInsertPath = useCallback((filePath: string) => {
    window.dispatchEvent(new CustomEvent('insert-input-text', {
      detail: { text: filePath, append: true }
    }));
  }, []);

  // Thinking state: only when we actively sent a message and haven't got a reply yet
  const isThinking = waitingForReply && !streamingText && !cancelledRef.current;

  // Running state: thinking, streaming, or a tool is in progress (but not after cancel)
  const isRunning = !cancelledRef.current && (isThinking || !!streamingText || events.some(e => e.event_type === 'tool_running'));

  return (
    <div className="app">
      <Header session={session} connected={connected} />

      <div className="app-body">
        {/* Sidebar toggle (always visible) */}
        <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarOpen ? 'Hide explorer' : 'Show explorer'}>
          {sidebarOpen ? '◀' : '▶'}
        </button>

        {/* File explorer sidebar */}
        {sidebarOpen && (
          <>
            <div className="sidebar" style={{ width: sidebarWidth }}>
              <FileExplorer onInsert={handleInsertPath} />
            </div>
            <div className="sidebar-resize" onMouseDown={onResizeStart} />
          </>
        )}

        {/* Main chat area */}
        <div className="main-panel">
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

              {groupedEvents.map((item) => {
                if ('filePath' in item) {
                  // Grouped edits — render as single card using the last event (has final diff)
                  const group = item as EditGroup;
                  const last = group.events[group.events.length - 1];
                  return (
                    <ChatMessage
                      key={`group-${group.events[0].id}`}
                      event={last}
                      onOpenDetail={handleOpenDetail}
                      editGroup={group}
                    />
                  );
                }
                const event = item as TimelineEvent;
                return (
                  <ChatMessage key={event.id} event={event} onOpenDetail={handleOpenDetail} />
                );
              })}

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

              {!connected && !needsAuth && (
                <div className="disconnect-banner">
                  <div className="disconnect-banner-dot" />
                  Connection lost — reconnecting...
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          <InputBox isRunning={isRunning} />
        </div>{/* end .main-panel */}
      </div>{/* end .app-body */}

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

      {/* Auth recovery overlay */}
      <AuthOverlay visible={needsAuth} />
    </div>
  );
}
