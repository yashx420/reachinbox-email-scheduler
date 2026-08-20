import type { NextFunction, Request, Response } from 'express';
import { verifySessionToken } from '../services/auth.service';
import { ApiError } from '../utils/errors';

/**
 * Bearer-token guard. The dashboard exchanges its Google ID token for our own
 * short-lived JWT once, then sends that on every request.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(ApiError.unauthorized('Missing bearer token.'));
    return;
  }

  try {
    req.user = verifySessionToken(header.slice('Bearer '.length).trim());
    next();
  } catch (err) {
    next(err);
  }
}

/** Narrows `req.user` for handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): { id: string; email: string } {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
