import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Thin wrappers rather than a generic data-grid: every table in the app wants
 * the same chrome, and the columns differ enough that a config-driven grid
 * would be more indirection than it saves.
 */
export function TableShell({ children }: { children: ReactNode }) {
  // Wide tables scroll inside the panel instead of the page.
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function TableHead({ columns }: { columns: { key: string; label: string; className?: string }[] }) {
  return (
    <thead>
      <tr className="border-b border-surface-border">
        {columns.map((column) => (
          <th
            key={column.key}
            scope="col"
            className={cn(
              'px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500',
              column.className,
            )}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function TableRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-surface-border/60 transition-colors last:border-0 hover:bg-surface-overlay/40">
      {children}
    </tr>
  );
}

export function TableCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('px-5 py-3.5 align-middle text-slate-300', className)}>{children}</td>;
}

/** Skeleton rows keep the table height stable between refreshes. */
export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-surface-border/60 last:border-0">
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <td key={cellIndex} className="px-5 py-4">
              <div className="relative h-3 overflow-hidden rounded-full bg-surface-overlay">
                <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-slate-700/40 to-transparent" />
              </div>
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
