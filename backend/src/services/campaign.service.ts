import { query, queryOne } from '../config/db';

export interface CampaignDto {
  id: string;
  name: string | null;
  subject: string;
  body: string;
  startAt: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number | null;
  totalRecipients: number;
  createdAt: string;
  progress: {
    pending: number;
    sent: number;
    failed: number;
    cancelled: number;
  };
}

interface CampaignListRow {
  id: string;
  name: string | null;
  subject: string;
  body: string;
  start_at: Date;
  delay_between_emails_ms: number;
  hourly_limit: number | null;
  total_recipients: number;
  created_at: Date;
  pending: number;
  sent: number;
  failed: number;
  cancelled: number;
}

function toDto(row: CampaignListRow): CampaignDto {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    startAt: row.start_at.toISOString(),
    delayBetweenEmailsMs: row.delay_between_emails_ms,
    hourlyLimit: row.hourly_limit,
    totalRecipients: row.total_recipients,
    createdAt: row.created_at.toISOString(),
    progress: {
      pending: row.pending,
      sent: row.sent,
      failed: row.failed,
      cancelled: row.cancelled,
    },
  };
}

const SELECT_WITH_PROGRESS = `
  SELECT c.id, c.name, c.subject, c.body, c.start_at, c.delay_between_emails_ms,
         c.hourly_limit, c.total_recipients, c.created_at,
         COUNT(j.*) FILTER (WHERE j.status IN ('scheduled','rate_limited','processing'))::bigint AS pending,
         COUNT(j.*) FILTER (WHERE j.status = 'sent')::bigint      AS sent,
         COUNT(j.*) FILTER (WHERE j.status = 'failed')::bigint    AS failed,
         COUNT(j.*) FILTER (WHERE j.status = 'cancelled')::bigint AS cancelled
    FROM campaigns c
    LEFT JOIN email_jobs j ON j.campaign_id = c.id
`;

export async function listCampaigns(userId: string, limit = 25): Promise<CampaignDto[]> {
  const rows = await query<CampaignListRow>(
    `${SELECT_WITH_PROGRESS}
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toDto);
}

export async function getCampaign(userId: string, campaignId: string): Promise<CampaignDto | null> {
  const row = await queryOne<CampaignListRow>(
    `${SELECT_WITH_PROGRESS}
      WHERE c.user_id = $1 AND c.id = $2
      GROUP BY c.id`,
    [userId, campaignId],
  );
  return row ? toDto(row) : null;
}
