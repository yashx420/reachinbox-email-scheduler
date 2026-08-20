import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../utils/logger';

const log = createLogger('http');

/** One line per request, with duration — enough to debug without a tracer. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const meta = {
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    };
    const line = `${req.method} ${req.originalUrl}`;
    if (res.statusCode >= 500) log.error(line, meta);
    else if (res.statusCode >= 400) log.warn(line, meta);
    else log.info(line, meta);
  });

  next();
}
