import { z } from 'zod';

/** Accepts anything `Date` can parse (ISO, RFC 2822) — friendlier for Postman. */
const dateInput = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid date/time' })
  .transform((value) => new Date(value));

const recipientInput = z.union([
  z.string(),
  z.object({
    email: z.string(),
    name: z.string().max(200).nullish(),
  }),
]);

export const googleLoginSchema = z.object({
  idToken: z.string().min(10, 'Missing Google credential'),
});

export const scheduleCampaignSchema = z
  .object({
    name: z.string().max(200).nullish(),
    subject: z.string().trim().min(1, 'Subject is required').max(500),
    body: z.string().trim().min(1, 'Body is required').max(100_000),
    /** Defaults to "now" so a quick Postman call needs two fields. */
    startAt: dateInput.optional(),
    delayBetweenEmailsMs: z.number().int().min(0).max(6 * 60 * 60 * 1000).optional(),
    hourlyLimit: z.number().int().min(0).max(100_000).nullish(),
    recipients: z.array(recipientInput).optional(),
    /** Raw CSV / newline-separated paste, parsed server-side. */
    recipientsText: z.string().max(10_000_000).optional(),
    idempotencyKey: z.string().max(200).optional(),
  })
  .refine(
    (value) => (value.recipients?.length ?? 0) > 0 || (value.recipientsText?.trim().length ?? 0) > 0,
    { message: 'Provide `recipients` or `recipientsText`', path: ['recipients'] },
  );

export type ScheduleCampaignBody = z.infer<typeof scheduleCampaignSchema>;

export const listEmailsQuerySchema = z.object({
  group: z.enum(['scheduled', 'sent', 'all']).default('scheduled'),
  status: z.enum(['scheduled', 'rate_limited', 'processing', 'sent', 'failed', 'cancelled']).optional(),
  campaignId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createSenderSchema = z.object({
  label: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(100).optional(),
  maxEmailsPerHour: z.number().int().min(0).nullish(),
});

export const uuidParamSchema = z.object({ id: z.string().uuid('Invalid id') });
