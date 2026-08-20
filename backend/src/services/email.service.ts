import { query, queryOne } from '../config/db';
import type { EmailJobRow, EmailStatus } from '../types/domain';

export interface EmailDto {
  id: string;
  campaignId: string;
  campaignName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  originalScheduledAt: string;
  dispatchedAt: string | null;
  sentAt: string | null;
  attempts: number;
  deferCount: number;
  previewUrl: string | null;
  messageId: string | null;
  error: string | null;
  sender: { id: string; label: string; fromEmail: string } | null;
  createdAt: string;
}

type EmailListRow = EmailJobRow & {
  sender_label: string | null;
  sender_from_email: string | null;
  campaign_name: string | null;
};

export function toEmailDto(row: EmailListRow): EmailDto {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    subject: row.subject,
    status: row.status,
    scheduledAt: row.scheduled_at.toISOString(),
    originalScheduledAt: row.original_scheduled_at.toISOString(),
    dispatchedAt: row.dispatched_at ? row.dispatched_at.toISOString() : null,
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    attempts: row.attempts,
    deferCount: row.defer_count,
    previewUrl: row.preview_url,
    messageId: row.message_id,
    error: row.last_error,
    sender: row.sender_id && row.sender_label
      ? { id: row.sender_id, label: row.sender_label, fromEmail: row.sender_from_email ?? '' }
      : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** "scheduled" and "sent" are the two dashboard tabs; `all` powers search. */
export type EmailGroup = 'scheduled' | 'sent' | 'all';

const GROUP_FILTERS: Record<EmailGroup, EmailStatus[] | null> = {
  scheduled: ['scheduled', 'rate_limited', 'processing'],
  sent: ['sent', 'failed'],
  all: null,
};

export interface ListEmailsParams {
  userId: string;
  group: EmailGroup;
  status?: EmailStatus;
  campaignId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function listEmails(params: ListEmailsParams): Promise<Paginated<EmailDto>> {
  const conditions = ['j.user_id = $1'];
  const values: unknown[] = [params.userId];

  const groupStatuses = GROUP_FILTERS[params.group];
  if (params.status) {
    values.push(params.status);
    conditions.push(`j.status = $${values.length}`);
  } else if (groupStatuses) {
    values.push(groupStatuses);
    conditions.push(`j.status = ANY($${values.length}::text[])`);
  }

  if (params.campaignId) {
    values.push(params.campaignId);
    conditions.push(`j.campaign_id = $${values.length}`);
  }

  if (params.search) {
    values.push(`%${params.search.toLowerCase()}%`);
    conditions.push(`(LOWER(j.recipient_email) LIKE $${values.length} OR LOWER(j.subject) LIKE $${values.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // Sent emails read newest-first; upcoming ones read next-to-go first.
  const orderBy = params.group === 'sent'
    ? 'ORDER BY j.sent_at DESC NULLS LAST, j.updated_at DESC'
    : 'ORDER BY j.scheduled_at ASC, j.sequence ASC';

  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::bigint AS total FROM email_jobs j ${where}`,
    values,
  );
  const total = countRow?.total ?? 0;

  const offset = (params.page - 1) * params.pageSize;
  const rows = await query<EmailListRow>(
    `SELECT j.*, s.label AS sender_label, s.from_email AS sender_from_email, c.name AS campaign_name
       FROM email_jobs j
       LEFT JOIN senders s ON s.id = j.sender_id
       LEFT JOIN campaigns c ON c.id = j.campaign_id
       ${where}
       ${orderBy}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, params.pageSize, offset],
  );

  return {
    items: rows.map(toEmailDto),
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

export interface EmailStats {
  total: number;
  scheduled: number;
  rateLimited: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  sentLastHour: number;
  nextSendAt: string | null;
}

interface StatsRow {
  total: number;
  scheduled: number;
  rate_limited: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  sent_last_hour: number;
  next_send_at: Date | null;
}

export async function getEmailStats(userId: string): Promise<EmailStats> {
  const row = await queryOne<StatsRow>(
    `SELECT
       COUNT(*)::bigint                                                         AS total,
       COUNT(*) FILTER (WHERE status = 'scheduled')::bigint                     AS scheduled,
       COUNT(*) FILTER (WHERE status = 'rate_limited')::bigint                  AS rate_limited,
       COUNT(*) FILTER (WHERE status = 'processing')::bigint                    AS processing,
       COUNT(*) FILTER (WHERE status = 'sent')::bigint                          AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')::bigint                        AS failed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::bigint                     AS cancelled,
       COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 hour')::bigint AS sent_last_hour,
       MIN(scheduled_at) FILTER (WHERE status IN ('scheduled', 'rate_limited')) AS next_send_at
     FROM email_jobs
     WHERE user_id = $1`,
    [userId],
  );

  return {
    total: row?.total ?? 0,
    scheduled: row?.scheduled ?? 0,
    rateLimited: row?.rate_limited ?? 0,
    processing: row?.processing ?? 0,
    sent: row?.sent ?? 0,
    failed: row?.failed ?? 0,
    cancelled: row?.cancelled ?? 0,
    sentLastHour: row?.sent_last_hour ?? 0,
    nextSendAt: row?.next_send_at ? row.next_send_at.toISOString() : null,
  };
}

export async function getEmailById(userId: string, id: string): Promise<EmailDto | null> {
  const row = await queryOne<EmailListRow>(
    `SELECT j.*, s.label AS sender_label, s.from_email AS sender_from_email, c.name AS campaign_name
       FROM email_jobs j
       LEFT JOIN senders s ON s.id = j.sender_id
       LEFT JOIN campaigns c ON c.id = j.campaign_id
      WHERE j.id = $1 AND j.user_id = $2`,
    [id, userId],
  );
  return row ? toEmailDto(row) : null;
}
