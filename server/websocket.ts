import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { DbEvent } from './types.js';

interface Client {
  ws: WebSocket;
  sessionId: string | null;
  lastEventId: number;
}

let wss: WebSocketServer;
const clients: Set<Client> = new Set();

export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: Client = { ws, sessionId: null, lastEventId: 0 };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          client.sessionId = msg.session_id || null;
          client.lastEventId = msg.last_event_id || 0;
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
  broadcast(sessionId, 'event', { event });
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
