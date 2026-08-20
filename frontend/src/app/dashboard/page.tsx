'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ComposeModal } from '@/components/compose/ComposeModal';
import { EmailTable } from '@/components/dashboard/EmailTable';
import { Header } from '@/components/dashboard/Header';
import { ThroughputPanel } from '@/components/dashboard/ThroughputPanel';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/Button';
import { InputField } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { StatCard } from '@/components/ui/StatCard';
import { Tabs } from '@/components/ui/Tabs';
import { useEmails, useStats, useThroughput, type EmailGroup } from '@/hooks/useDashboard';
import { ApiError, api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { Email } from '@/types/api';

const ICONS = {
  clock: (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  gauge: (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M4 17a8 8 0 1 1 16 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m12 13 4-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M12 8.5v4m0 3h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
};

export default function DashboardPage() {
  const { user, status, signOut } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState<EmailGroup>('scheduled');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 350);
  const [composeOpen, setComposeOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const isReady = status === 'authenticated';

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/');
  }, [status, router]);

  // A new tab or search term always starts at page 1.
  useEffect(() => {
    setPage(1);
  }, [tab, search]);

  const emails = useEmails(tab, search, page, isReady);
  const stats = useStats(isReady);
  const throughput = useThroughput(isReady);

  const composeDefaults = useMemo(
    () => ({
      delayMs: throughput.data?.config.minDelayBetweenEmailsMs ?? 2_000,
      hourlyLimit: throughput.data?.config.maxEmailsPerHourPerSender ?? 100,
      windowMs: throughput.data?.config.rateLimitWindowMs ?? 3_600_000,
    }),
    [throughput.data],
  );

  const refreshAll = () => {
    emails.refresh();
    stats.refresh();
    throughput.refresh();
  };

  const cancelEmail = async (email: Email) => {
    setCancellingId(email.id);
    try {
      await api.cancelEmail(email.id);
      toast.success(`Cancelled the email to ${email.recipientEmail}`);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel that email.');
    } finally {
      setCancellingId(null);
    }
  };

  if (!isReady || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-slate-600" />
      </main>
    );
  }

  const pendingCount = (stats.data?.scheduled ?? 0) + (stats.data?.rateLimited ?? 0) + (stats.data?.processing ?? 0);

  return (
    <div className="min-h-screen">
      <Header user={user} onSignOut={signOut} />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-100">Campaign dashboard</h1>
            <p className="mt-1 text-sm text-slate-500">
              {stats.data?.nextSendAt
                ? `Next email goes out ${formatRelative(stats.data.nextSendAt)}.`
                : 'Nothing is queued right now.'}
            </p>
          </div>

          <Button onClick={() => setComposeOpen(true)}>
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            Compose new email
          </Button>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Scheduled"
            value={pendingCount}
            icon={ICONS.clock}
            loading={stats.loading}
            hint={stats.data?.rateLimited ? `${stats.data.rateLimited} waiting on the hourly cap` : undefined}
          />
          <StatCard
            label="Sent"
            value={stats.data?.sent ?? 0}
            icon={ICONS.check}
            tone="success"
            loading={stats.loading}
          />
          <StatCard
            label="Sent last hour"
            value={stats.data?.sentLastHour ?? 0}
            icon={ICONS.gauge}
            loading={stats.loading}
          />
          <StatCard
            label="Failed"
            value={stats.data?.failed ?? 0}
            icon={ICONS.alert}
            tone={stats.data?.failed ? 'danger' : 'default'}
            loading={stats.loading}
          />
        </section>

        <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
          <section className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border p-4">
              <Tabs
                active={tab}
                onChange={setTab}
                items={[
                  { id: 'scheduled', label: 'Scheduled', count: pendingCount },
                  { id: 'sent', label: 'Sent', count: (stats.data?.sent ?? 0) + (stats.data?.failed ?? 0) },
                ]}
              />

              <div className="flex items-center gap-2">
                {emails.refreshing && <Spinner className="h-3.5 w-3.5 text-slate-600" />}
                <InputField
                  label=""
                  aria-label="Search emails"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search recipient or subject"
                  containerClassName="w-full sm:w-64"
                  className="h-9 py-0 text-sm"
                />
              </div>
            </div>

            <EmailTable
              group={tab}
              page={emails.data}
              loading={emails.loading}
              error={emails.error}
              onCancel={(email) => void cancelEmail(email)}
              cancellingId={cancellingId}
              onCompose={() => setComposeOpen(true)}
              onPageChange={setPage}
            />
          </section>

          <ThroughputPanel data={throughput.data} loading={throughput.loading} />
        </div>
      </main>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onScheduled={refreshAll}
        defaults={composeDefaults}
      />
    </div>
  );
}
