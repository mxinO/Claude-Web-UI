import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import type { DbEvent } from './types.js';
import { checkAuthCookie } from './auth.js';
import { getEvents } from './db.js';

const MAX_CATCHUP_EVENTS = 500;

interface Client {
  ws: WebSocket;
  sessionId: string | null;
  lastEventId: number;
}

let wss: WebSocketServer;
const clients: Set<Client> = new Set();

export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req: IncomingMessage) => {
    if (!checkAuthCookie(req.headers.cookie)) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    const client: Client = { ws, sessionId: null, lastEventId: 0 };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          client.sessionId = msg.session_id || null;
          const lastId = msg.last_event_id || 0;
          client.lastEventId = lastId;

          // Catch-up: send events the client missed since lastEventId
          if (client.sessionId && lastId > 0) {
            try {
              const missed = getEvents(client.sessionId, {
                afterId: lastId,
                limit: MAX_CATCHUP_EVENTS,
              });
              for (const event of missed) {
                if (ws.readyState !== WebSocket.OPEN) break;
                ws.send(JSON.stringify({ type: 'event', event }));
                // Track highest sent ID so broadcast() skips duplicates
                if (event.id > client.lastEventId) {
                  client.lastEventId = event.id;
                }
              }
            } catch (err) {
              console.error('[ws] Catch-up failed:', err);
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(client);
    });
  });

  return wss;
}

export function broadcast(sessionId: string, type: string, payload: Record<string, unknown>): void {
  const message = JSON.stringify({ type, ...payload });
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (!client.sessionId || client.sessionId === sessionId) {
        client.ws.send(message);
      }
    }
  }
}

export function broadcastEvent(sessionId: string, event: DbEvent): void {
  const message = JSON.stringify({ type: 'event', event });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.sessionId && client.sessionId !== sessionId) continue;
    // Skip events already sent via catch-up (prevents out-of-order duplicates)
    if (event.id > 0 && event.id <= client.lastEventId) continue;
    client.ws.send(message);
    if (event.id > 0 && event.id > client.lastEventId) {
      client.lastEventId = event.id;
    }
  }
}

export function broadcastPermission(sessionId: string, permissionId: string, eventId: number, toolName: string, toolInput: unknown): void {
  broadcast(sessionId, 'permission_request', {
    permission_id: permissionId,
    event_id: eventId,
    tool_name: toolName,
    tool_input: toolInput,
  });
}

// Note: broadcastPermissionDecision is used by api.ts after a user approves/denies a permission.
// Keeping it here for potential multi-tab support (other tabs can react to the decision in real-time).
export function broadcastPermissionDecision(sessionId: string, permissionId: string, decision: string): void {
  broadcast(sessionId, 'permission_decided', {
    permission_id: permissionId,
    decision,
  });
}
