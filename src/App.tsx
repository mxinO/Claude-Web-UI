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
import QuestionPrompt from './components/QuestionPrompt';
import type { QuestionData } from './components/QuestionPrompt';
import GoalBanner from './components/GoalBanner';
import FileViewer, { shouldOpenInNewTab, fileApiUrl } from './components/FileViewer';
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
  const [questionData, setQuestionData] = useState<QuestionData | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  // Server-authoritative "Claude is working" (turn active). Survives page
  // refresh and the gaps where streaming is paused (tool runs, question picker).
  const [serverBusy, setServerBusy] = useState(false);
  // Active `/goal` (Claude working autonomously across turns). Keeps the running
  // indicator lit across auto-continued turns and drives the goal banner.
  const [goal, setGoal] = useState<{ condition: string | null } | null>(null);
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
    // End of turn = the FINAL assistant message (status 'end_turn') or a stop
    // event. Intermediate assistant_message events now arrive mid-turn (text
    // emitted before/between tool calls, captured from the JSONL transcript);
    // clearing the working state on those made the UI look idle while Claude
    // was still working. Only the final one ends the turn.
    const isTurnEnd =
      event.event_type === 'stop' ||
      (event.event_type === 'assistant_message' && event.status === 'end_turn');
    if (isTurnEnd) {
      streamingTextRef.current = null;
      setStreamingText(null);
      setStreamingExpanded(false);
      cancelledRef.current = false;
      setCancelledText(null);
      setWaitingForReply(false);
    } else if (event.event_type === 'assistant_message') {
      // Intermediate text block — Claude is still working. Clear the live
      // preview for this block (it's now a real message) but keep the
      // thinking/stop indicators alive.
      streamingTextRef.current = null;
      setStreamingText(null);
    }
    if (event.event_type === 'user_message') {
      // New turn — reset cancelled state
      cancelledRef.current = false;
      setCancelledText(null);
    }
    addEvent(event);
  }, [addEvent]);

  // Turn-end backstop: the Stop hook stops the (non-quiet) streaming poll,
  // which broadcasts streaming_done. Clear the working state in case no
  // 'end_turn' assistant_message arrived (e.g. a turn that ended without
  // final text).
  const onStreamingDone = useCallback(() => {
    streamingTextRef.current = null;
    setStreamingText(null);
    setWaitingForReply(false);
  }, []);

  const { connected } = useWebSocket({ onEvent, onStreaming, onStreamingDone, onQueueChange, session, setSession });
  const { needsAuth } = useAuthRecovery();

  // A pending question bar / goal banner belongs to one session; drop them if
  // the session changes (the watcher re-broadcasts goal state for the new one).
  useEffect(() => { setQuestionData(null); setGoal(null); }, [session?.id]);

  // Seed the busy indicator on load/refresh from the server, so a turn that
  // was already in progress still shows a running indicator.
  useEffect(() => {
    fetch('/api/current-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && typeof d.busy === 'boolean') setServerBusy(d.busy);
        if (d?.goal?.active) setGoal({ condition: d.goal.condition ?? null });
      })
      .catch(() => {});
  }, []);

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
      // Match the server's timestamp format ("YYYY-MM-DD HH:MM:SS.sss") so
      // this event sorts chronologically alongside real events. ISO with the
      // `T` separator + `Z` suffix would lex-sort AFTER everything because
      // 'T' > ' ', pinning bash output to the bottom of the timeline.
      const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
      addEvent({
        id,
        session_id: session?.id ?? '',
        timestamp: ts,
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
    const questionHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as QuestionData | undefined;
      if (detail && Array.isArray(detail.options) && detail.options.length) {
        setQuestionData({ question: detail.question, options: detail.options });
      }
    };
    const questionClearedHandler = () => setQuestionData(null);
    // Drop any pending question bar when the connection drops, so it can't
    // answer a stale session after reconnect/switch.
    const dropQuestion = () => { setQuestionData(null); setServerBusy(false); };
    window.addEventListener('claude-dead', dropQuestion);
    // Server-driven busy signal (turn start/end). Folds into the running
    // indicator so it shows even after refresh / during paused-streaming gaps.
    const busyHandler = (e: Event) => {
      const busy = !!(e as CustomEvent).detail?.busy;
      setServerBusy(busy);
      if (busy) cancelledRef.current = false; // new turn started
    };
    window.addEventListener('claude-busy', busyHandler);
    // Goal state: a /goal makes Claude work across turns with no per-turn busy
    // signal, so track it separately and fold it into the running indicator.
    const goalActiveHandler = (e: Event) => {
      const condition = (e as CustomEvent).detail?.condition ?? null;
      setGoal({ condition });
      cancelledRef.current = false; // goal is actively running
    };
    const goalClearedHandler = () => setGoal(null);
    window.addEventListener('goal-active', goalActiveHandler);
    window.addEventListener('goal-cleared', goalClearedHandler);
    // A goal belongs to the live session; a death drops it too.
    window.addEventListener('claude-dead', goalClearedHandler);
    // Open the shared file viewer when a file path link is clicked anywhere
    // (chat messages, file explorer). Browser-native formats (pdf/html) open
    // straight in a new tab — the in-app panel can't render them inline; every
    // other type opens in the panel. Dispatched synchronously from the click
    // handler, so window.open stays within the user gesture (no popup block).
    const viewFileHandler = (e: Event) => {
      const p = (e as CustomEvent).detail?.path;
      if (typeof p !== 'string' || !p) return;
      if (shouldOpenInNewTab(p)) {
        // If a popup blocker nixes the new tab, fall back to the panel (which
        // offers its own "Open in new tab ↗" affordance) rather than dead-click.
        const w = window.open(fileApiUrl(p), '_blank', 'noopener,noreferrer');
        if (w) return;
      }
      setViewerPath(p);
    };
    window.addEventListener('view-file', viewFileHandler);
    window.addEventListener('claude-message-sent', handler);
    window.addEventListener('bash-output', scrollToBottom);
    window.addEventListener('claude-dead', deadHandler);
    window.addEventListener('claude-restarting', restartingHandler);
    window.addEventListener('question-prompt', questionHandler);
    window.addEventListener('question-cleared', questionClearedHandler);
    return () => {
      window.removeEventListener('claude-message-sent', handler);
      window.removeEventListener('bash-output', scrollToBottom);
      window.removeEventListener('claude-dead', deadHandler);
      window.removeEventListener('claude-restarting', restartingHandler);
      window.removeEventListener('question-prompt', questionHandler);
      window.removeEventListener('question-cleared', questionClearedHandler);
      window.removeEventListener('claude-dead', dropQuestion);
      window.removeEventListener('claude-busy', busyHandler);
      window.removeEventListener('goal-active', goalActiveHandler);
      window.removeEventListener('goal-cleared', goalClearedHandler);
      window.removeEventListener('claude-dead', goalClearedHandler);
      window.removeEventListener('view-file', viewFileHandler);
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

  // Thinking state: Claude is working but no live text yet. Driven by the
  // local "just sent" flag OR the server-authoritative turn-active signal
  // (the latter survives refresh and covers paused-streaming gaps). An active
  // goal also counts as working — and overrides a local cancel, since a goal
  // keeps running across turns even if the user interrupted a single one.
  const isThinking = !streamingText && (!!goal || ((waitingForReply || serverBusy) && !cancelledRef.current));

  // Running state: thinking, streaming, a tool in progress, the server says the
  // turn is active (but not after a local cancel), or a goal is active.
  const isRunning = !!goal || (!cancelledRef.current && (isThinking || !!streamingText || serverBusy || events.some(e => e.event_type === 'tool_running')));

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

          {goal && <GoalBanner condition={goal.condition} />}
          {questionData && (
            <QuestionPrompt
              data={questionData}
              onAnswered={() => setQuestionData(null)}
            />
          )}
          <InputBox isRunning={isRunning} goalActive={!!goal} />
        </div>{/* end .main-panel */}
      </div>{/* end .app-body */}

      {/* Detail modal for tool calls */}
      {modalEvent && (
        <DetailModal event={modalEvent} onClose={handleCloseDetail} />
      )}

      {/* Shared file viewer (file explorer + clicked file paths in messages) */}
      {viewerPath && (
        <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} />
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
