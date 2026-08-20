'use client';

import { GoogleLogin } from '@react-oauth/google';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { GOOGLE_CLIENT_ID } from '@/components/providers/AppProviders';
import { useAuth } from '@/components/providers/AuthProvider';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';
import { ApiError } from '@/lib/api';

const HIGHLIGHTS = [
  'Delayed jobs in BullMQ — no cron, nothing lost on restart',
  'Per-sender hourly caps enforced in Redis across every worker',
  'A minimum gap between sends, however large the campaign',
];

export default function LoginPage() {
  const { status, signIn } = useAuth();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  const handleCredential = async (credential?: string) => {
    if (!credential) {
      toast.error('Google did not return a credential. Please try again.');
      return;
    }

    setSigningIn(true);
    try {
      await signIn(credential);
      toast.success('Signed in');
      router.replace('/dashboard');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setSigningIn(false);
    }
  };

  if (status === 'loading' || status === 'authenticated') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-slate-600" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="grid w-full max-w-4xl gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <section className="space-y-6">
          <Logo />
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
              Schedule cold email
              <br />
              that actually goes out on time.
            </h1>
            <p className="max-w-md text-sm leading-relaxed text-slate-400">
              Upload a lead list, pick a start time, and the scheduler handles the rest — pacing,
              hourly limits and sender rotation included.
            </p>
          </div>

          <ul className="space-y-2.5">
            {HIGHLIGHTS.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-slate-400">
                <svg viewBox="0 0 20 20" fill="none" className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden="true">
                  <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.4" />
                  <path d="m6.5 10.2 2.3 2.3 4.7-4.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel p-8">
          <div className="space-y-1.5 text-center">
            <h2 className="text-lg font-semibold text-slate-100">Sign in to continue</h2>
            <p className="text-sm text-slate-500">Use your Google account to reach the dashboard.</p>
          </div>

          <div className="mt-7 flex min-h-[44px] justify-center">
            {signingIn ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Spinner className="h-4 w-4" />
                Signing you in…
              </div>
            ) : GOOGLE_CLIENT_ID ? (
              <GoogleLogin
                onSuccess={(response) => void handleCredential(response.credential)}
                onError={() => toast.error('Google sign-in was cancelled or blocked.')}
                theme="filled_black"
                shape="pill"
                width="280"
              />
            ) : (
              // Fail loudly but usefully: this is the one setup step that
              // cannot be defaulted.
              <p className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-center text-xs leading-relaxed text-amber-300">
                Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> in
                <code className="font-mono"> frontend/.env.local</code> (and the matching
                <code className="font-mono"> GOOGLE_CLIENT_ID</code> in <code className="font-mono">backend/.env</code>),
                then restart the dev server.
              </p>
            )}
          </div>

          <p className="mt-7 text-center text-xs leading-relaxed text-slate-600">
            We only read your name, email and avatar to identify your campaigns.
          </p>
        </section>
      </div>
    </main>
  );
}
