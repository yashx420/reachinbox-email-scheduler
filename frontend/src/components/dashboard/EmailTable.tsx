'use client';

import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TableCell, TableHead, TableRow, TableShell, TableSkeleton } from '@/components/ui/Table';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Email, Paginated } from '@/types/api';
import type { EmailGroup } from '@/hooks/useDashboard';

const COLUMNS: Record<EmailGroup, { key: string; label: string; className?: string }[]> = {
  scheduled: [
    { key: 'email', label: 'Email' },
    { key: 'subject', label: 'Subject' },
    { key: 'scheduled', label: 'Scheduled time' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: '', className: 'text-right' },
  ],
  sent: [
    { key: 'email', label: 'Email' },
    { key: 'subject', label: 'Subject' },
    { key: 'sent', label: 'Sent time' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: '', className: 'text-right' },
  ],
};

const EMPTY_COPY: Record<EmailGroup, { title: string; description: string }> = {
  scheduled: {
    title: 'Nothing scheduled yet',
    description: 'Compose an email and upload a lead list — queued sends will appear here with their exact send time.',
  },
  sent: {
    title: 'No emails sent yet',
    description: 'Once the scheduler starts working through a campaign, delivered and failed sends land here.',
  },
};

const MailIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="m4 8 7.2 5.1a1.4 1.4 0 0 0 1.6 0L20 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

interface EmailTableProps {
  group: EmailGroup;
  page: Paginated<Email> | null;
  loading: boolean;
  error: string | null;
  onCancel: (email: Email) => void;
  cancellingId: string | null;
  onCompose: () => void;
  onPageChange: (page: number) => void;
}

export function EmailTable({
  group,
  page,
  loading,
  error,
  onCancel,
  cancellingId,
  onCompose,
  onPageChange,
}: EmailTableProps) {
  const columns = COLUMNS[group];

  if (error) {
    return (
      <EmptyState
        icon={
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
            <path d="M12 8v5m0 3h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        }
        title="Could not load emails"
        description={error}
      />
    );
  }

  // Skeleton only on the first load of a tab; background refreshes keep the
  // existing rows on screen so the table never flickers.
  if (loading && !page) {
    return (
      <TableShell>
        <TableHead columns={columns} />
        <TableSkeleton rows={5} columns={columns.length} />
      </TableShell>
    );
  }

  if (!page || page.items.length === 0) {
    return (
      <EmptyState
        icon={MailIcon}
        title={EMPTY_COPY[group].title}
        description={EMPTY_COPY[group].description}
        action={
          group === 'scheduled' ? (
            <Button size="sm" onClick={onCompose}>
              Compose new email
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      <TableShell>
        <TableHead columns={columns} />
        <tbody>
          {page.items.map((email) => (
            <TableRow key={email.id}>
              <TableCell>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-200">{email.recipientEmail}</p>
                  {email.sender && (
                    <p className="truncate text-xs text-slate-500">via {email.sender.label}</p>
                  )}
                </div>
              </TableCell>

              <TableCell>
                <p className="max-w-[22rem] truncate">{email.subject}</p>
                {email.campaignName && (
                  <p className="max-w-[22rem] truncate text-xs text-slate-500">{email.campaignName}</p>
                )}
              </TableCell>

              <TableCell>
                <p className="tabular-nums text-slate-300">
                  {formatDateTime(group === 'sent' ? email.sentAt : email.scheduledAt)}
                </p>
                <p className="text-xs text-slate-500">
                  {formatRelative(group === 'sent' ? email.sentAt : email.scheduledAt)}
                </p>
              </TableCell>

              <TableCell>
                <StatusBadge status={email.status} />
                {email.status === 'rate_limited' && (
                  <p className="mt-1 text-xs text-amber-400/80">
                    Hourly cap reached — moved to the next window
                  </p>
                )}
                {email.status === 'failed' && email.error && (
                  <p className="mt-1 max-w-[16rem] truncate text-xs text-rose-400/80" title={email.error}>
                    {email.error}
                  </p>
                )}
              </TableCell>

              <TableCell className="text-right">
                {group === 'sent' && email.previewUrl && (
                  <a
                    href={email.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-brand-300 underline-offset-2 hover:underline"
                  >
                    View message
                  </a>
                )}
                {group === 'scheduled' && (email.status === 'scheduled' || email.status === 'rate_limited') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={cancellingId === email.id}
                    onClick={() => onCancel(email)}
                  >
                    Cancel
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </TableShell>

      {page.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-surface-border px-5 py-3 text-xs text-slate-500">
          <span>
            Page {page.page} of {page.totalPages} · {page.total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page.page <= 1}
              onClick={() => onPageChange(page.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page.page >= page.totalPages}
              onClick={() => onPageChange(page.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
