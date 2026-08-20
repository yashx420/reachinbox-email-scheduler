import { env } from '../config/env';
import { getRedis } from '../config/redis';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('ratelimit');

/**
 * Fixed-window hourly quota, enforced in Redis so it holds across every worker
 * process and every API instance (an in-memory counter would let N workers
 * send N x limit).
 *
 * Both the global and the per-sender counter are checked *and* incremented
 * inside one Lua script, so the check-then-increment pair is atomic: two
 * workers cannot both observe "one slot left" and both take it.
 */
const CONSUME_SCRIPT = `
local globalKey  = KEYS[1]
local senderKey  = KEYS[2]
local globalMax  = tonumber(ARGV[1])
local senderMax  = tonumber(ARGV[2])
local ttlMs      = tonumber(ARGV[3])

local globalUsed = tonumber(redis.call('GET', globalKey) or '0')
local senderUsed = tonumber(redis.call('GET', senderKey) or '0')

if globalMax > 0 and globalUsed >= globalMax then
  return {0, 'global', globalUsed, senderUsed}
end
if senderMax > 0 and senderUsed >= senderMax then
  return {0, 'sender', globalUsed, senderUsed}
end

if globalMax > 0 then
  globalUsed = redis.call('INCR', globalKey)
  if globalUsed == 1 then redis.call('PEXPIRE', globalKey, ttlMs) end
end
if senderMax > 0 then
  senderUsed = redis.call('INCR', senderKey)
  if senderUsed == 1 then redis.call('PEXPIRE', senderKey, ttlMs) end
end

return {1, 'ok', globalUsed, senderUsed}
`;

/** Only refunds a slot we actually took, and never below zero. */
const REFUND_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;

export type RateLimitScope = 'global' | 'sender';

export interface RateLimitDecision {
  allowed: boolean;
  /** Which counter rejected the send (only set when `allowed` is false). */
  blockedBy?: RateLimitScope;
  globalUsed: number;
  senderUsed: number;
  windowStart: number;
  /** Epoch ms at which the blocking window rolls over. */
  nextWindowStart: number;
}

export function windowStartFor(timestamp = Date.now()): number {
  return Math.floor(timestamp / env.rateLimit.windowMs) * env.rateLimit.windowMs;
}

export function nextWindowStartFor(timestamp = Date.now()): number {
  return windowStartFor(timestamp) + env.rateLimit.windowMs;
}

function globalKey(windowStart: number): string {
  return `${env.queuePrefix}:rl:global:${windowStart}`;
}

function senderKey(senderId: string, windowStart: number): string {
  return `${env.queuePrefix}:rl:sender:${senderId}:${windowStart}`;
}

/**
 * Tries to reserve one send slot for `senderId`.
 *
 * `senderLimit` lets an individual sender row override
 * MAX_EMAILS_PER_HOUR_PER_SENDER (e.g. a mailbox still warming up).
 */
export async function consumeSendSlot(
  senderId: string,
  senderLimit?: number | null,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowStart = windowStartFor(now);
  const globalMax = env.rateLimit.globalPerHour;
  const senderMax = senderLimit ?? env.rateLimit.perSenderPerHour;

  // Both limits disabled: skip the round trip entirely.
  if (globalMax <= 0 && senderMax <= 0) {
    return {
      allowed: true,
      globalUsed: 0,
      senderUsed: 0,
      windowStart,
      nextWindowStart: windowStart + env.rateLimit.windowMs,
    };
  }

  // TTL is two windows so a counter that is read right at the boundary still
  // exists for inspection; the key name already scopes it to one window.
  const raw = (await getRedis().eval(
    CONSUME_SCRIPT,
    2,
    globalKey(windowStart),
    senderKey(senderId, windowStart),
    String(globalMax),
    String(senderMax),
    String(env.rateLimit.windowMs * 2),
  )) as [number, string, number, number];

  const decision: RateLimitDecision = {
    allowed: raw[0] === 1,
    globalUsed: raw[2],
    senderUsed: raw[3],
    windowStart,
    nextWindowStart: windowStart + env.rateLimit.windowMs,
  };
  if (!decision.allowed) decision.blockedBy = raw[1] as RateLimitScope;

  return decision;
}

/**
 * Gives a reserved slot back when the send did not actually happen (SMTP
 * error, sender lookup failure). Without this a burst of transient failures
 * would silently eat the hour's quota.
 */
export async function refundSendSlot(senderId: string, windowStart: number): Promise<void> {
  const redis = getRedis();
  try {
    if (env.rateLimit.globalPerHour > 0) {
      await redis.eval(REFUND_SCRIPT, 1, globalKey(windowStart));
    }
    if (env.rateLimit.perSenderPerHour > 0) {
      await redis.eval(REFUND_SCRIPT, 1, senderKey(senderId, windowStart));
    }
  } catch (err) {
    // A lost refund only costs us one slot in the current window; never let it
    // fail the job.
    log.warn('Failed to refund rate-limit slot', { senderId, windowStart, error: describeError(err) });
  }
}

export interface RateLimitUsage {
  windowStart: number;
  nextWindowStart: number;
  windowMs: number;
  global: { used: number; limit: number };
  senders: Record<string, { used: number; limit: number }>;
}

/** Read-only snapshot for the dashboard's "throughput" panel. */
export async function readUsage(
  senders: { id: string; max_emails_per_hour: number | null }[],
): Promise<RateLimitUsage> {
  const windowStart = windowStartFor();
  const redis = getRedis();

  const keys = [globalKey(windowStart), ...senders.map((s) => senderKey(s.id, windowStart))];
  const values = keys.length > 0 ? await redis.mget(...keys) : [];

  const senderUsage: RateLimitUsage['senders'] = {};
  senders.forEach((sender, index) => {
    senderUsage[sender.id] = {
      used: Number(values[index + 1] ?? 0),
      limit: sender.max_emails_per_hour ?? env.rateLimit.perSenderPerHour,
    };
  });

  return {
    windowStart,
    nextWindowStart: windowStart + env.rateLimit.windowMs,
    windowMs: env.rateLimit.windowMs,
    global: { used: Number(values[0] ?? 0), limit: env.rateLimit.globalPerHour },
    senders: senderUsage,
  };
}
