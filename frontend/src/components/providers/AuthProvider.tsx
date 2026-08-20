'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { clearSession, readSession, writeSession, SESSION_EXPIRED_EVENT } from '@/lib/session';
import type { AuthUser } from '@/types/api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  /** Exchanges a Google ID token for an API session. */
  signIn: (googleIdToken: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  // Starts as `loading` so guarded pages never flash the login screen while
  // localStorage is being read.
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    const session = readSession();
    setUser(session?.user ?? null);
    setStatus(session ? 'authenticated' : 'unauthenticated');
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  // The API client fires this when a request comes back 401.
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, signOut);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, signOut);
  }, [signOut]);

  const signIn = useCallback(async (googleIdToken: string) => {
    const session = await api.loginWithGoogle(googleIdToken);
    writeSession(session.token, session.user);
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, signIn, signOut }),
    [user, status, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
