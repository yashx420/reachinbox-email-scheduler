import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { queryOne } from '../config/db';
import { ApiError } from '../utils/errors';
import { createLogger, describeError } from '../utils/logger';
import type { AuthenticatedUser, UserRow } from '../types/domain';

const log = createLogger('auth');

let googleClient: OAuth2Client | null = null;

function getGoogleClient(): OAuth2Client {
  if (!env.auth.googleClientId) {
    throw ApiError.unavailable(
      'GOOGLE_CLIENT_ID is not configured on the API. Add it to backend/.env and restart.',
    );
  }
  googleClient ??= new OAuth2Client(env.auth.googleClientId);
  return googleClient;
}

/**
 * Verifies the ID token minted by Google Identity Services in the browser.
 * `verifyIdToken` checks the signature against Google's JWKS plus the audience
 * and expiry, so a forged or replayed token from another app is rejected here
 * rather than trusted client-side.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<TokenPayload> {
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: env.auth.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw ApiError.unauthorized('Google token did not include an email address.');
    }
    if (payload.email_verified === false) {
      throw ApiError.forbidden('Your Google email address is not verified.');
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log.warn('Google token verification failed', { error: describeError(err) });
    throw ApiError.unauthorized('Could not verify your Google sign-in. Please try again.');
  }
}

export async function upsertUserFromGoogle(payload: TokenPayload): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `INSERT INTO users (google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       avatar_url = EXCLUDED.avatar_url,
       last_login_at = now()
     RETURNING *`,
    [payload.sub, payload.email!.toLowerCase(), payload.name ?? null, payload.picture ?? null],
  );
  if (!row) throw new Error('Failed to persist user');
  return row;
}

export interface SessionClaims {
  sub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export function issueSessionToken(user: UserRow): string {
  const claims: SessionClaims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
  };
  // `expiresIn` accepts a duration string ("7d"); the cast keeps us compatible
  // with both the older and the newer @types/jsonwebtoken signatures.
  const options = { expiresIn: env.auth.jwtExpiresIn as unknown as SignOptions['expiresIn'] };
  return jwt.sign(claims, env.auth.jwtSecret, options);
}

export function verifySessionToken(token: string): AuthenticatedUser {
  try {
    const claims = jwt.verify(token, env.auth.jwtSecret) as SessionClaims;
    return {
      id: claims.sub,
      email: claims.email,
      name: claims.name ?? null,
      avatarUrl: claims.avatarUrl ?? null,
    };
  } catch {
    throw ApiError.unauthorized('Your session has expired. Please sign in again.');
  }
}

export function toAuthUser(row: UserRow): AuthenticatedUser {
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
}

export async function loginWithGoogle(idToken: string): Promise<{ token: string; user: AuthenticatedUser }> {
  const payload = await verifyGoogleIdToken(idToken);
  const user = await upsertUserFromGoogle(payload);
  log.info('User signed in', { userId: user.id, email: user.email });
  return { token: issueSessionToken(user), user: toAuthUser(user) };
}
