import { cn } from '@/lib/cn';
import type { EmailStatus } from '@/types/api';

const STATUS_STYLES: Record<EmailStatus, { label: string; className: string; dot: string }> = {
  scheduled: { label: 'Scheduled', className: 'bg-sky-500/10 text-sky-300 border-sky-500/25', dot: 'bg-sky-400' },
  rate_limited: {
    label: 'Rate limited',
    className: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
    dot: 'bg-amber-400',
  },
  processing: {
    label: 'Sending',
    className: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
    dot: 'bg-indigo-400 animate-pulse',
  },
  sent: { label: 'Sent', className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25', dot: 'bg-emerald-400' },
  failed: { label: 'Failed', className: 'bg-rose-500/10 text-rose-300 border-rose-500/25', dot: 'bg-rose-400' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-500/10 text-slate-400 border-slate-500/25', dot: 'bg-slate-500' },
};

export function StatusBadge({ status }: { status: EmailStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        style.className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  );
}

export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-surface-border bg-surface-overlay px-2 py-0.5 text-xs text-slate-400',
        className,
      )}
    >
      {children}
    </span>
  );
}
