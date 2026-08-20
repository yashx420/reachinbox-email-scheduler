import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SenderRow } from '../types/domain';
import { createLogger } from '../utils/logger';

const log = createLogger('mailer');

// One pooled transport per sender. Pooling matters once WORKER_CONCURRENCY > 1:
// without it every send would pay a fresh TLS handshake.
type PooledTransporter = Transporter<SMTPPool.SentMessageInfo>;

const transports = new Map<string, { key: string; transport: PooledTransporter }>();

function cacheKeyFor(sender: SenderRow): string {
  // Rotating a mailbox's credentials bumps updated_at, which retires the
  // cached transport instead of failing every send until a restart.
  return `${sender.host}:${sender.port}:${sender.username}:${sender.updated_at.getTime()}`;
}

function transportFor(sender: SenderRow): PooledTransporter {
  const key = cacheKeyFor(sender);
  const cached = transports.get(sender.id);
  if (cached && cached.key === key) return cached.transport;

  cached?.transport.close();

  const transport = nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: { user: sender.username, pass: sender.password },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  transports.set(sender.id, { key, transport });
  return transport;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Turns the plain-text body from the composer into a readable HTML part. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 16px;">${block.replace(/\n/g, '<br />')}</p>`)
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827;">${paragraphs}</div>`;
}

export interface SendEmailInput {
  to: string;
  toName?: string | null;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  messageId: string;
  /** Ethereal's web view of the message — the "proof" link shown in the UI. */
  previewUrl: string | null;
}

export async function sendEmail(sender: SenderRow, input: SendEmailInput): Promise<SendEmailResult> {
  const transport = transportFor(sender);

  const info = await transport.sendMail({
    from: { name: sender.from_name, address: sender.from_email },
    to: input.toName ? { name: input.toName, address: input.to } : input.to,
    subject: input.subject,
    text: input.body,
    html: textToHtml(input.body),
  });

  // @types/nodemailer declares getTestMessageUrl against the non-pooled info
  // shape; the fields it actually reads (envelope, messageId) are on both.
  const previewUrl = nodemailer.getTestMessageUrl(info as unknown as SMTPTransport.SentMessageInfo);

  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === 'string' ? previewUrl : null,
  };
}

/** Used by the senders API to surface bad credentials before a campaign runs. */
export async function verifySender(sender: SenderRow): Promise<boolean> {
  try {
    await transportFor(sender).verify();
    return true;
  } catch {
    return false;
  }
}

export interface EtherealAccount {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  webUrl: string;
}

const ETHEREAL_API = process.env.ETHEREAL_API ?? 'https://api.nodemailer.com';

interface EtherealApiResponse {
  status: string;
  user: string;
  pass: string;
  smtp: { host: string; port: number; secure: boolean };
  web?: string;
}

/**
 * Provisions a throwaway Ethereal mailbox. Ethereal accepts every message and
 * never delivers it, so this is safe to point at real-looking lead lists.
 *
 * This is the same endpoint `nodemailer.createTestAccount()` calls, used
 * directly because nodemailer caches a single account per process — which
 * would hand every "sender" in the pool the same mailbox.
 */
export async function createEtherealAccount(label: string): Promise<EtherealAccount> {
  const response = await fetch(`${ETHEREAL_API}/user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestor: 'reachinbox-email-scheduler', version: '1.0.0' }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Ethereal account request failed with status ${response.status}`);
  }

  const account = (await response.json()) as EtherealApiResponse;
  if (!account?.user || !account?.pass || !account?.smtp?.host) {
    throw new Error('Ethereal returned an unexpected payload');
  }

  log.info('Created Ethereal account', { label, user: account.user });

  return {
    label,
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    user: account.user,
    pass: account.pass,
    webUrl: account.web ?? 'https://ethereal.email/login',
  };
}

export function closeAllTransports(): void {
  for (const { transport } of transports.values()) transport.close();
  transports.clear();
}
