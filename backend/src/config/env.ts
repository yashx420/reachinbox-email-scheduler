import 'dotenv/config';

/**
 * Every tunable lives here. Nothing in the codebase reads `process.env`
 * directly, so a missing or malformed value fails loudly at boot instead of
 * silently changing behaviour halfway through a campaign.
 */
export class ConfigError extends Error {}

function raw(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(key: string, fallback: string): string {
  return raw(key) ?? fallback;
}

function requiredStr(key: string, hint: string): string {
  const value = raw(key);
  if (!value) throw new ConfigError(`Missing required env var ${key}. ${hint}`);
  return value;
}

function num(key: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const value = raw(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`Env var ${key} must be a number, got "${value}".`);
  if (opts.min !== undefined && parsed < opts.min) {
    throw new ConfigError(`Env var ${key} must be >= ${opts.min}, got ${parsed}.`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new ConfigError(`Env var ${key} must be <= ${opts.max}, got ${parsed}.`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const value = raw(key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`Env var ${key} must be a boolean, got "${value}".`);
}

function list(key: string, fallback: string[]): string[] {
  const value = raw(key);
  if (value === undefined) return fallback;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

export interface SmtpAccountConfig {
  label: string;
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
  fromEmail?: string;
  fromName?: string;
  maxEmailsPerHour?: number;
}

function smtpAccounts(key: string): SmtpAccountConfig[] {
  const value = raw(key);
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(`Env var ${key} must be valid JSON (an array of SMTP accounts).`);
  }
  if (!Array.isArray(parsed)) throw new ConfigError(`Env var ${key} must be a JSON array.`);
  return parsed.map((entry, index) => {
    const account = entry as Partial<SmtpAccountConfig>;
    if (!account.host || !account.user || !account.pass) {
      throw new ConfigError(`${key}[${index}] needs at least "host", "user" and "pass".`);
    }
    return {
      label: account.label ?? `sender-${index + 1}`,
      host: account.host,
      port: account.port ?? 587,
      secure: account.secure ?? false,
      user: account.user,
      pass: account.pass,
      fromEmail: account.fromEmail ?? account.user,
      fromName: account.fromName ?? 'ReachInbox',
      maxEmailsPerHour: account.maxEmailsPerHour,
    };
  });
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProduction,
  port: num('PORT', 4000, { min: 1, max: 65535 }),
  logLevel: str('LOG_LEVEL', 'info'),
  corsOrigins: list('CORS_ORIGIN', ['http://localhost:3000']),

  databaseUrl: requiredStr('DATABASE_URL', 'Point it at your Postgres instance, e.g. postgres://user:pass@localhost:5432/reachinbox'),
  databasePoolMax: num('DATABASE_POOL_MAX', 10, { min: 1 }),

  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  queuePrefix: str('QUEUE_PREFIX', 'reachinbox'),

  auth: {
    googleClientId: str('GOOGLE_CLIENT_ID', ''),
    jwtSecret: isProduction
      ? requiredStr('JWT_SECRET', 'Set a long random string; it signs dashboard sessions.')
      : str('JWT_SECRET', 'insecure-development-secret'),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '7d'),
  },

  worker: {
    /** Emails a single worker process may have in flight simultaneously. */
    concurrency: num('WORKER_CONCURRENCY', 5, { min: 1, max: 500 }),
    /** Minimum spacing between two sends, enforced by BullMQ's Redis limiter. */
    minDelayBetweenEmailsMs: num('MIN_DELAY_BETWEEN_EMAILS_MS', 2000, { min: 0 }),
    /** Sends allowed per `minDelayBetweenEmailsMs` window (1 => strict spacing). */
    rateLimitBurst: num('RATE_LIMIT_BURST', 1, { min: 1 }),
    /**
     * Runs a worker inside the API process so `npm run dev` is enough to see
     * mail go out. Set to false to run `npm run dev:worker` separately (or to
     * scale workers independently in production).
     */
    runInline: bool('RUN_WORKER_INLINE', true),
  },

  rateLimit: {
    /** 0 disables the global limit. */
    globalPerHour: num('MAX_EMAILS_PER_HOUR', 500, { min: 0 }),
    /** 0 disables the per-sender limit. Overridable per sender row in the DB. */
    perSenderPerHour: num('MAX_EMAILS_PER_HOUR_PER_SENDER', 100, { min: 0 }),
    /** Window length. 3_600_000 = one hour; shrink it to demo the limiter. */
    windowMs: num('RATE_LIMIT_WINDOW_MS', 3_600_000, { min: 1000 }),
  },

  delivery: {
    maxAttempts: num('EMAIL_MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
    backoffMs: num('EMAIL_BACKOFF_MS', 5000, { min: 0 }),
    maxRecipientsPerCampaign: num('MAX_RECIPIENTS_PER_CAMPAIGN', 10_000, { min: 1 }),
    reconcileOnBoot: bool('RECONCILE_ON_BOOT', true),
    /** A job left in `processing` for longer than this is assumed orphaned. */
    staleProcessingMs: num('STALE_PROCESSING_MS', 120_000, { min: 1000 }),
  },

  ethereal: {
    senderCount: num('ETHEREAL_SENDER_COUNT', 3, { min: 1, max: 20 }),
    accounts: smtpAccounts('SMTP_ACCOUNTS'),
  },
} as const;

export type Env = typeof env;
