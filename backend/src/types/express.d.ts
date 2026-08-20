import type { AuthenticatedUser } from './domain';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth`; absent on public routes. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
