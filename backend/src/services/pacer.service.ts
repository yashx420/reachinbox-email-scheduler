import { env } from '../config/env';
import { getRedis } from '../config/redis';

/**
 * Exact spacing between sends, on top of BullMQ's limiter.
 *
 * BullMQ's `limiter: { max, duration }` is a *fixed* window: with max=1 and a
 * 2s window, a job at 1.9s and the next at 2.1s are both allowed, so two
 * emails can leave 200ms apart. That is fine for protecting a provider from
 * bursts, but it does not deliver the "minimum N seconds between individual
 * sends" guarantee the scheduler promises.
 *
 * So each worker also reserves a position in a shared Redis "next free slot"
 * ledger. The script hands back the timestamp this send may go out at and
 * advances the ledger by the spacing — atomically, so N workers across M
 * processes queue up behind each other instead of colliding.
 */
const RESERVE_SLOT_SCRIPT = `
local key       = KEYS[1]
local spacingMs = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])

local nextAt = tonumber(redis.call('GET', key) or '0')
if nextAt < now then nextAt = now end

-- Expire well after the reserved slot so an idle queue starts fresh instead of
-- inheriting a stale backlog.
redis.call('SET', key, nextAt + spacingMs, 'PX', spacingMs * 8 + 60000)
return tostring(nextAt)
`;

function paceKey(scope: string): string {
  return `${env.queuePrefix}:pace:${scope}`;
}

/**
 * Reserves the next send slot and returns the epoch-ms at which the caller may
 * send. Spacing is global (one ledger for the whole fleet) because the promise
 * is about the system's outbound rate, not one mailbox's.
 */
export async function reserveSendSlot(spacingMs: number, scope = 'global'): Promise<number> {
  if (spacingMs <= 0) return Date.now();

  const result = (await getRedis().eval(
    RESERVE_SLOT_SCRIPT,
    1,
    paceKey(scope),
    String(spacingMs),
    String(Date.now()),
  )) as string;

  return Number(result);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
