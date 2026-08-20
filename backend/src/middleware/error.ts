import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors';
import { createLogger, describeError } from '../utils/logger';
import { env } from '../config/env';

const log = createLogger('http');

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Single place that turns anything thrown in a handler into a response shaped
 * `{ error: { code, message, details? } }` — the frontend only ever has to
 * understand one error format.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Some fields are invalid.',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    if (err.status >= 500) log.error(err.message, { path: req.path, code: err.code });
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  log.error('Unhandled error', { path: req.path, method: req.method, error: describeError(err) });
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: env.isProduction ? 'Something went wrong.' : describeError(err),
    },
  });
}
