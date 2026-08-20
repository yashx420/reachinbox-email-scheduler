import type { AuthUser } from '@/types/api';

const TOKEN_KEY = 'reachinbox.token';
const USER_KEY = 'reachinbox.user';

/** Fired when the API rejects our token so the app can bounce to the login screen. */
export const SESSION_EXPIRED_EVENT = 'reachinbox:session-expired';

const isBrowser = () => typeof window !== 'undefined';

export function readSession(): { token: string; user: AuthUser } | null {
  if (!isBrowser()) return null;

  const token = window.localStorage.getItem(TOKEN_KEY);
  const rawUser = window.localStorage.getItem(USER_KEY);
  if (!token || !rawUser) return null;

  try {
    return { token, user: JSON.parse(rawUser) as AuthUser };
  } catch {
    // Corrupted payload: treat it as signed out rather than crashing on boot.
    clearSession();
    return null;
  }
}

export function writeSession(token: string, user: AuthUser): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export function getToken(): string | null {
  return isBrowser() ? window.localStorage.getItem(TOKEN_KEY) : null;
}

export function notifySessionExpired(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
