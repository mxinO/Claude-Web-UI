import crypto from 'crypto';
import os from 'os';

let authToken: string | null = null;

// Cookie name includes hostname so two servers on different nodes
// (accessed via the same localhost SSH tunnel) don't overwrite each other's cookies.
const COOKIE_NAME = `webui_token_${os.hostname().replace(/[^a-zA-Z0-9]/g, '')}`;

/** Initialize auth with a random token. Call with null to disable auth. */
export function initAuth(enabled: boolean): void {
  authToken = enabled ? crypto.randomBytes(24).toString('base64url') : null;
}

/** Get the current auth token, or null if auth is disabled. */
export function getAuthToken(): string | null {
  return authToken;
}

/** Get the cookie name (unique per hostname). */
export function getCookieName(): string {
  return COOKIE_NAME;
}

/** Check if a cookie header contains a valid auth token. */
export function checkAuthCookie(cookieHeader: string | undefined): boolean {
  if (!authToken) return true; // auth disabled
  if (!cookieHeader) return false;
  const tokenCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  return !!(tokenCookie && tokenCookie.substring(COOKIE_NAME.length + 1) === authToken);
}
