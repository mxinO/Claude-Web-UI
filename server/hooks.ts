import { Express } from 'express';
import type { DbEvent } from './types.js';

interface HookRouteOptions {
  broadcastEvent: (sessionId: string, event: DbEvent) => void;
  broadcastPermission: (sessionId: string, permissionId: string, eventId: number, toolName: string, toolInput: unknown) => void;
}

// Placeholder — full implementation provided separately
export function registerHookRoutes(_app: Express, _opts: HookRouteOptions): void {
  // Hook routes will be registered here
}
