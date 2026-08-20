import { env } from '../config/env';
import { query, queryOne } from '../config/db';
import { createEtherealAccount } from './mailer.service';
import type { SenderRow } from '../types/domain';
import { createLogger } from '../utils/logger';

const log = createLogger('senders');

const SENDER_COLUMNS = `
  id, label, host, port, secure, username, password, from_email, from_name,
  max_emails_per_hour, web_url, is_active, created_at, updated_at
`;

export async function listSenders(activeOnly = false): Promise<SenderRow[]> {
  return query<SenderRow>(
    `SELECT ${SENDER_COLUMNS} FROM senders ${activeOnly ? 'WHERE is_active = TRUE' : ''} ORDER BY created_at ASC`,
  );
}

export async function getSenderById(id: string): Promise<SenderRow | null> {
  return queryOne<SenderRow>(`SELECT ${SENDER_COLUMNS} FROM senders WHERE id = $1`, [id]);
}

export interface CreateSenderInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail?: string;
  fromName?: string;
  maxEmailsPerHour?: number | null;
  webUrl?: string | null;
}

export async function createSender(input: CreateSenderInput): Promise<SenderRow> {
  const row = await queryOne<SenderRow>(
    `INSERT INTO senders (label, host, port, secure, username, password, from_email, from_name, max_emails_per_hour, web_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (label) DO UPDATE SET
       host = EXCLUDED.host, port = EXCLUDED.port, secure = EXCLUDED.secure,
       username = EXCLUDED.username, password = EXCLUDED.password,
       from_email = EXCLUDED.from_email, from_name = EXCLUDED.from_name,
       max_emails_per_hour = EXCLUDED.max_emails_per_hour, web_url = EXCLUDED.web_url
     RETURNING ${SENDER_COLUMNS}`,
    [
      input.label,
      input.host,
      input.port,
      input.secure,
      input.username,
      input.password,
      input.fromEmail ?? input.username,
      input.fromName ?? 'ReachInbox',
      input.maxEmailsPerHour ?? null,
      input.webUrl ?? null,
    ],
  );
  if (!row) throw new Error('Failed to persist sender');
  return row;
}

export async function setSenderActive(id: string, isActive: boolean): Promise<SenderRow | null> {
  return queryOne<SenderRow>(
    `UPDATE senders SET is_active = $2 WHERE id = $1 RETURNING ${SENDER_COLUMNS}`,
    [id, isActive],
  );
}

/**
 * Guarantees the pool is non-empty: uses SMTP_ACCOUNTS when provided,
 * otherwise provisions ETHEREAL_SENDER_COUNT throwaway Ethereal mailboxes.
 * Idempotent — labels are unique, so re-running only tops the pool up.
 */
export async function ensureSenders(): Promise<SenderRow[]> {
  const existing = await listSenders(true);
  if (existing.length > 0) return existing;

  if (env.ethereal.accounts.length > 0) {
    log.info('Importing senders from SMTP_ACCOUNTS', { count: env.ethereal.accounts.length });
    const created: SenderRow[] = [];
    for (const account of env.ethereal.accounts) {
      created.push(
        await createSender({
          label: account.label,
          host: account.host,
          port: account.port,
          secure: account.secure ?? false,
          username: account.user,
          password: account.pass,
          fromEmail: account.fromEmail ?? account.user,
          fromName: account.fromName ?? 'ReachInbox',
          maxEmailsPerHour: account.maxEmailsPerHour ?? null,
        }),
      );
    }
    return created;
  }

  log.info('No senders configured — provisioning Ethereal mailboxes', { count: env.ethereal.senderCount });
  const created: SenderRow[] = [];
  for (let index = 0; index < env.ethereal.senderCount; index += 1) {
    const account = await createEtherealAccount(`ethereal-${index + 1}`);
    created.push(
      await createSender({
        label: account.label,
        host: account.host,
        port: account.port,
        secure: account.secure,
        username: account.user,
        password: account.pass,
        fromEmail: account.user,
        fromName: 'ReachInbox',
        webUrl: account.webUrl,
      }),
    );
  }
  return created;
}

/** Round-robin assignment, so a campaign spreads evenly over the pool. */
export function pickSender(senders: SenderRow[], index: number): SenderRow {
  const sender = senders[index % senders.length];
  if (!sender) throw new Error('No active senders available');
  return sender;
}

/** Candidate order for one job: its assigned sender first, then the rest. */
export function rotateFrom(senders: SenderRow[], senderId: string | null): SenderRow[] {
  if (!senderId) return senders;
  const start = senders.findIndex((sender) => sender.id === senderId);
  if (start <= 0) return senders;
  return [...senders.slice(start), ...senders.slice(0, start)];
}
