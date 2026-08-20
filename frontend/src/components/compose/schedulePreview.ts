export interface SchedulePreviewInput {
  count: number;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  /** Rate-limit window length reported by the API (usually one hour). */
  windowMs: number;
}

/**
 * Mirrors the backend's `planSendTimes` so the composer can show when a
 * campaign will finish before anything is submitted. Emails fill one window
 * spaced by `delayMs`, then spill into the next.
 */
export function estimateLastSendAt({
  count,
  startAt,
  delayMs,
  hourlyLimit,
  windowMs,
}: SchedulePreviewInput): Date | null {
  if (count <= 0) return null;

  const lastIndex = count - 1;
  const spaced = startAt.getTime() + lastIndex * delayMs;

  if (hourlyLimit <= 0) return new Date(spaced);

  const windowIndex = Math.floor(lastIndex / hourlyLimit);
  const positionInWindow = lastIndex % hourlyLimit;
  const windowed = startAt.getTime() + windowIndex * windowMs + positionInWindow * delayMs;

  return new Date(Math.max(spaced, windowed));
}
