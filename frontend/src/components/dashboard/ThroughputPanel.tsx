'use client';

import { Pill } from '@/components/ui/Badge';
import { formatDuration, formatNumber, formatTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Throughput } from '@/types/api';

function UsageBar({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) return <Pill>no limit</Pill>;

  const ratio = Math.min(1, used / limit);
  const tone = ratio >= 1 ? 'bg-rose-400' : ratio >= 0.75 ? 'bg-amber-400' : 'bg-brand-400';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-overlay">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="tabular-nums text-xs text-slate-400">
        {formatNumber(used)}/{formatNumber(limit)}
      </span>
    </div>
  );
}

/**
 * Makes the throttling visible: what the limits are, how much of the current
 * window is spent, and how deep the queue is right now.
 */
export function ThroughputPanel({ data, loading }: { data: Throughput | null; loading: boolean }) {
  if (loading && !data) {
    return (
      <section className="panel space-y-3 p-5">
        <div className="h-4 w-32 animate-pulse rounded bg-surface-overlay" />
        <div className="h-20 animate-pulse rounded-xl bg-surface-overlay" />
      </section>
    );
  }

  if (!data) return null;

  const queue = 'error' in data.queue ? null : data.queue;

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Throughput</h2>
          <p className="text-xs text-slate-500">
            Window resets at {formatTime(data.window.resetsAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill>concurrency {data.config.concurrency}</Pill>
          <Pill>min gap {formatDuration(data.config.minDelayBetweenEmailsMs)}</Pill>
          <Pill>window {formatDuration(data.config.rateLimitWindowMs)}</Pill>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-surface-border bg-surface-base/40 p-3.5">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Global this window</dt>
          <dd className="mt-2">
            <UsageBar used={data.global.used} limit={data.global.limit} />
          </dd>
        </div>

        <div className="rounded-xl border border-surface-border bg-surface-base/40 p-3.5">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Queue</dt>
          <dd className="mt-2 flex flex-wrap gap-3 text-xs tabular-nums text-slate-400">
            {queue ? (
              <>
                <span>delayed {formatNumber(queue.delayed ?? 0)}</span>
                <span>waiting {formatNumber(queue.waiting ?? 0)}</span>
                <span>active {formatNumber(queue.active ?? 0)}</span>
                <span>failed {formatNumber(queue.failed ?? 0)}</span>
              </>
            ) : (
              <span className="text-rose-400">Queue unavailable</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-3 space-y-2">
        <p className="text-xs uppercase tracking-wide text-slate-500">Senders</p>
        {data.senders.map((sender) => (
          <div
            key={sender.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-surface-border bg-surface-base/40 px-3.5 py-2.5"
          >
            <span className="flex items-center gap-2 text-sm text-slate-300">
              <span className={cn('h-1.5 w-1.5 rounded-full', sender.isActive ? 'bg-emerald-400' : 'bg-slate-600')} />
              {sender.label}
            </span>
            <UsageBar used={sender.used} limit={sender.limit} />
          </div>
        ))}
      </div>
    </section>
  );
}
