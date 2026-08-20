/** Shapes that mirror the database rows returned by `pg`. */

export type EmailStatus =
  | 'scheduled'
  | 'rate_limited'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

/** Statuses that still owe the user an email. */
export const PENDING_STATUSES: EmailStatus[] = ['scheduled', 'rate_limited', 'processing'];

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
  last_login_at: Date;
}

export interface SenderRow {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_email: string;
  from_name: string;
  max_emails_per_hour: number | null;
  web_url: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CampaignRow {
  id: string;
  user_id: string;
  name: string | null;
  subject: string;
  body: string;
  start_at: Date;
  delay_between_emails_ms: number;
  hourly_limit: number | null;
  total_recipients: number;
  idempotency_key: string | null;
  created_at: Date;
}

export interface EmailJobRow {
  id: string;
  campaign_id: string;
  user_id: string;
  sender_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  sequence: number;
  scheduled_at: Date;
  original_scheduled_at: Date;
  status: EmailStatus;
  attempts: number;
  defer_count: number;
  locked_at: Date | null;
  dispatched_at: Date | null;
  sent_at: Date | null;
  message_id: string | null;
  preview_url: string | null;
  last_error: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

/** Payload carried on the BullMQ job. Kept tiny — the row is the source of truth. */
export interface EmailJobPayload {
  emailJobId: string;
  campaignId: string;
  /** Position in the campaign; used to preserve order across rate-limit windows. */
  sequence: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}
