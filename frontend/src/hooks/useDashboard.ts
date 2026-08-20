'use client';

import { api } from '@/lib/api';
import { usePolledResource } from './usePolledResource';
import type { Email, EmailStats, Paginated, Throughput } from '@/types/api';

export type EmailGroup = 'scheduled' | 'sent';

/** Upcoming mail changes fastest, so it polls a little harder than the rest. */
const POLL_MS: Record<EmailGroup, number> = { scheduled: 4_000, sent: 6_000 };

export function useEmails(group: EmailGroup, search: string, page: number, enabled: boolean) {
  return usePolledResource<Paginated<Email>>(
    `emails:${group}:${search}:${page}`,
    (signal) => api.listEmails({ group, search: search || undefined, page, pageSize: 10, signal }),
    { intervalMs: POLL_MS[group], enabled },
  );
}

export function useStats(enabled: boolean) {
  return usePolledResource<EmailStats>('stats', (signal) => api.stats(signal), {
    intervalMs: 5_000,
    enabled,
  });
}

export function useThroughput(enabled: boolean) {
  return usePolledResource<Throughput>('throughput', (signal) => api.throughput(signal), {
    intervalMs: 8_000,
    enabled,
  });
}
