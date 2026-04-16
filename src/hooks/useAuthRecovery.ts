import { useState, useEffect } from 'react';

/**
 * Connection recovery: detects when the server is unreachable (network blip)
 * vs when auth is truly lost (server restarted with new token).
 *
 * On 401: a single shared probe retries the server — if the cookie is still
 * valid the original request is re-issued transparently.
 * Only shows the re-auth overlay if the probe also fails with 401.
 */

let authLost = false;
let interceptorInstalled = false;
let probePromise: Promise<boolean> | null = null;

let originalFetch: typeof window.fetch = window.fetch.bind(window);

/** Single shared probe: only one runs at a time, all concurrent 401s await it. */
function probeAuth(): Promise<boolean> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    // Brief delay to let the network settle after a blip
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await originalFetch('/api/sessions/latest');
      return res.ok;
    } catch {
      return false;
    } finally {
      probePromise = null;
    }
  })();
  return probePromise;
}

function installInterceptor() {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  originalFetch = window.fetch.bind(window);

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await originalFetch(input, init);
    } catch (err) {
      // Network error (offline) — let caller handle it
      throw err;
    }

    // Only intercept /api/ 401s
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (res.status === 401 && !authLost && url.includes('/api/')) {
      const ok = await probeAuth();
      if (ok) {
        // Cookie is valid — re-issue the original request
        return originalFetch(input, init);
      }
      // Auth is truly lost (server restarted)
      if (!authLost) {
        authLost = true;
        window.dispatchEvent(new CustomEvent('auth-lost'));
      }
    }

    return res;
  };
}

/** Hook that tracks auth-lost state and installs the global interceptor. */
export function useAuthRecovery() {
  const [needsAuth, setNeedsAuth] = useState(authLost);

  useEffect(() => {
    installInterceptor();

    const onLost = () => setNeedsAuth(true);
    const onRestored = () => {
      authLost = false;
      setNeedsAuth(false);
    };
    window.addEventListener('auth-lost', onLost);
    window.addEventListener('auth-restored', onRestored);
    return () => {
      window.removeEventListener('auth-lost', onLost);
      window.removeEventListener('auth-restored', onRestored);
    };
  }, []);

  return { needsAuth };
}
