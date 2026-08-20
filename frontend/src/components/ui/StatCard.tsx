import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

interface StatCardProps {
  label: string;
  value: number;
  hint?: string;
  icon: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  loading?: boolean;
}

const TONES = {
  default: 'text-brand-300 bg-brand-500/10',
  success: 'text-emerald-300 bg-emerald-500/10',
  warning: 'text-amber-300 bg-amber-500/10',
  danger: 'text-rose-300 bg-rose-500/10',
} as const;

export function StatCard({ label, value, hint, icon, tone = 'default', loading }: StatCardProps) {
  return (
    <div className="panel flex items-center gap-4 p-4">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', TONES[tone])}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        {loading ? (
          <div className="mt-1.5 h-6 w-12 animate-pulse rounded bg-surface-overlay" />
        ) : (
          <p className="text-2xl font-semibold tabular-nums text-slate-100">{formatNumber(value)}</p>
        )}
        {hint && <p className="truncate text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}
