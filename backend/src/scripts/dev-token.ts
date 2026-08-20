import { closePool, queryOne } from '../config/db';
import { runMigrations } from '../db/migrator';
import { issueSessionToken } from '../services/auth.service';
import { createLogger, describeError } from '../utils/logger';
import type { UserRow } from '../types/domain';

const log = createLogger('scripts:dev-token');

/**
 * Mints an API session token for a local user so the endpoints can be driven
 * from curl/Postman without a browser Google sign-in.
 *
 * Deliberately a CLI script and not an HTTP route: there is no way to obtain
 * one of these tokens over the network.
 *
 *   npm run dev:token -- you@example.com
 */
async function main(): Promise<void> {
  const email = (process.argv[2] ?? 'dev@reachinbox.local').toLowerCase();

  await runMigrations();

  const user = await queryOne<UserRow>(
    `INSERT INTO users (google_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_id) DO UPDATE SET last_login_at = now()
     RETURNING *`,
    [`dev:${email}`, email, 'Local Dev User'],
  );
  if (!user) throw new Error('Could not create the dev user');

  // eslint-disable-next-line no-console
  console.log(`\nuser  ${user.email}  (${user.id})\ntoken ${issueSessionToken(user)}\n`);
}

main()
  .catch((err) => {
    log.error('Failed to mint token', { error: describeError(err) });
    process.exitCode = 1;
  })
  .finally(() => closePool());
