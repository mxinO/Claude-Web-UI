import crypto from 'crypto';

let authToken: string | null = null;

/** Initialize auth with a random token. Call with null to disable auth. */
export function initAuth(enabled: boolean): void {
  authToken = enabled ? crypto.randomBytes(24).toString('base64url') : null;
}

/** Get the current auth token, or null if auth is disabled. */
export function getAuthToken(): string | null {
  return authToken;
}

/** Check if a cookie header contains a valid auth token. */
export function checkAuthCookie(cookieHeader: string | undefined): boolean {
  if (!authToken) return true; // auth disabled
  if (!cookieHeader) return false;
  const tokenCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('webui_token='));
  return !!(tokenCookie && tokenCookie.substring('webui_token='.length) === authToken);
}
