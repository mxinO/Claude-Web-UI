import { randomUUID } from 'crypto';
import { sendInput } from './tmux.js';
import { insertEvent, getEvent } from './db.js';
import { broadcast, broadcastEvent } from './websocket.js';

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
}

let queue: QueuedMessage[] = [];
let claudeBusy = false;

// Session ID getter — set externally to break circular import with hooks.ts
let sessionIdGetter: () => string | null = () => null;
export function setSessionIdGetter(fn: () => string | null): void { sessionIdGetter = fn; }

export function isClaudeBusy(): boolean { return claudeBusy; }

/** Hard reset: clear busy flag and discard all queued messages. Use on session switch. */
export function resetQueue(): void {
  claudeBusy = false;
  const sessionId = sessionIdGetter();
  for (const msg of queue) {
    if (sessionId) broadcast(sessionId, 'queue_remove', { id: msg.id });
  }
  queue = [];
}

export function setClaudeBusy(busy: boolean): void {
  if (busy) {
    claudeBusy = true;
    return;
  }
  // Only drain if transitioning from busy -> idle
  if (!claudeBusy) return;
  claudeBusy = false;
  drainQueue();
}

export function getQueue(): QueuedMessage[] {
  return [...queue];
}

export function enqueue(text: string): QueuedMessage {
  const msg: QueuedMessage = { id: randomUUID(), text, timestamp: Date.now() };
  queue.push(msg);
  const sessionId = sessionIdGetter();
  if (sessionId) broadcast(sessionId, 'queue_add', { message: msg });
  return msg;
}

export function removeQueued(id: string): QueuedMessage | null {
  const idx = queue.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const [msg] = queue.splice(idx, 1);
  const sessionId = sessionIdGetter();
  if (sessionId) broadcast(sessionId, 'queue_remove', { id: msg.id });
  return msg;
}

/** Send the first queued message to Claude */
function drainQueue(): void {
  if (queue.length === 0) return;
  const msg = queue.shift()!;
  const sessionId = sessionIdGetter();
  if (sessionId) broadcast(sessionId, 'queue_remove', { id: msg.id });

  // Send to tmux and create the user_message event
  sendInput(msg.text);
  claudeBusy = true;

  if (sessionId) {
    const eventId = insertEvent(sessionId, 'user_message', {
      message_text: msg.text,
      status: 'completed',
    });
    const event = getEvent(eventId);
    if (event) broadcastEvent(sessionId, event);
  }
}
