'use client';

import { GoogleOAuthProvider } from '@react-oauth/google';
import { Toaster } from 'react-hot-toast';
import type { ReactNode } from 'react';
import { AuthProvider } from './AuthProvider';

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    // The provider only loads Google's script; the sign-in screen renders a
    // setup hint when the client id is missing rather than a broken button.
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#151b2e',
              color: '#e2e8f0',
              border: '1px solid #232a42',
              fontSize: '14px',
            },
            success: { iconTheme: { primary: '#34d399', secondary: '#151b2e' } },
            error: { iconTheme: { primary: '#fb7185', secondary: '#151b2e' }, duration: 6000 },
          }}
        />
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
