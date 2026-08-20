/** Mirrors the JSON contracts served by the Express API. */

export type EmailStatus =
  | 'scheduled'
  | 'rate_limited'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface EmailSender {
  id: string;
  label: string;
  fromEmail: string;
}

export interface Email {
  id: string;
  campaignId: string;
  campaignName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  originalScheduledAt: string;
  /** When the message was handed to SMTP — the minimum-delay guarantee applies here. */
  dispatchedAt: string | null;
  sentAt: string | null;
  attempts: number;
  deferCount: number;
  previewUrl: string | null;
  messageId: string | null;
  error: string | null;
  sender: EmailSender | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

export interface ScheduleRequest {
  name?: string | null;
  subject: string;
  body: string;
  startAt: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number | null;
  recipients: { email: string; name: string | null }[];
  idempotencyKey?: string;
}

export interface ScheduleResponse {
  campaign: {
    id: string;
    name: string | null;
    subject: string;
    startAt: string;
    delayBetweenEmailsMs: number;
    hourlyLimit: number | null;
    totalRecipients: number;
  };
  scheduledCount: number;
  firstSendAt: string | null;
  lastSendAt: string | null;
  sendersInPool: number;
  startAtAdjusted: boolean;
  skipped: { invalid: number; duplicates: number; invalidSamples: string[] };
  reused: boolean;
}

export interface Sender {
  id: string;
  label: string;
  host: string;
  port: number;
  fromEmail: string;
  fromName: string;
  maxEmailsPerHour: number | null;
  webUrl: string | null;
  isActive: boolean;
  createdAt: string;
  usage: { used: number; limit: number };
}

export interface Throughput {
  queue: Record<string, number> | { error: string };
  config: {
    concurrency: number;
    minDelayBetweenEmailsMs: number;
    burstPerWindow: number;
    maxEmailsPerHour: number;
    maxEmailsPerHourPerSender: number;
    rateLimitWindowMs: number;
    maxAttempts: number;
  };
  window: { startedAt: string; resetsAt: string };
  global: { used: number; limit: number };
  senders: { id: string; label: string; isActive: boolean; used: number; limit: number }[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
