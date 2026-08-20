# ReachInbox — Email Job Scheduler

A production-shaped email scheduler: an Express + TypeScript API that accepts campaigns,
persists them in Postgres, schedules every message as a **BullMQ delayed job**, and sends
through **Ethereal** SMTP under a configurable concurrency, minimum send gap and hourly
quota. A Next.js dashboard sits on top with real Google sign-in.

**No cron anywhere** — not `crontab`, not `node-cron`, not `agenda`, and not a polling loop.
A message's delivery time *is* its BullMQ delay.

```
┌────────────┐   POST /api/emails/schedule   ┌───────────────┐
│  Next.js   │ ────────────────────────────► │  Express API  │
│ dashboard  │ ◄──────────────────────────── │               │
└────────────┘   scheduled / sent / stats    └───────┬───────┘
                                                     │ 1. INSERT rows (Postgres = what to send)
                                                     │ 2. addBulk delayed jobs (Redis = when)
                                                     ▼
                                          ┌─────────────────────┐
                                          │  BullMQ  email-send │
                                          └──────────┬──────────┘
                                                     │ job fires at scheduled_at
                                                     ▼
                                   ┌──────────────────────────────────┐
                                   │ Worker (concurrency = N)         │
                                   │  claim row  → hourly quota check │
                                   │  → pace slot → SMTP → mark sent  │
                                   └──────────────────────────────────┘
```

---

## 1. Quick start

Prerequisites: **Node 20+**, **Docker** (for Postgres + Redis), and a **Google OAuth client ID**.

```bash
git clone <this-repo> && cd reachinbox-email-scheduler

# 1. Postgres + Redis
docker compose up -d

# 2. Install both apps
npm run install:all

# 3. Configure
cp backend/.env.example  backend/.env
cp frontend/.env.local.example frontend/.env.local
#   → put your Google client id in BOTH files (see §3)

# 4. Schema + throwaway SMTP mailboxes
npm --prefix backend run migrate
npm --prefix backend run senders:create

# 5. Run
npm run dev:api    # terminal 1 → http://localhost:4000
npm run dev:web    # terminal 2 → http://localhost:3000
```

The API starts an **in-process worker** by default so `dev:api` alone sends mail. To run the
worker separately (or to scale it), set `RUN_WORKER_INLINE=false` and start:

```bash
npm run dev:worker      # as many of these as you like — limits are shared via Redis
```

> **Port 5432 already in use?** Put `POSTGRES_PORT=5433` in a root `.env` and point
> `DATABASE_URL` at `localhost:5433`.

### No Docker?

Any local Postgres 13+ and Redis 6+ works — just update `DATABASE_URL` and `REDIS_URL`.

---

## 2. Repository layout

```
backend/
  src/
    config/      env parsing (fail-fast), pg pool, ioredis factories
    db/          .sql migrations + a forward-only migrator
    queue/       queue definition, enqueue helpers, worker, boot reconciler
    services/    scheduler, mailer, senders, rate limiter, pacer, auth, queries
    routes/      auth · emails · campaigns · senders · system  (+ zod schemas)
    middleware/  auth guard, request logger, error envelope
    scripts/     migrate · senders:create · dev:token · seed:load
    server.ts    API entrypoint        worker.ts  standalone worker entrypoint
frontend/
  src/
    app/         / (login) · /dashboard
    components/  ui/ (Button, Modal, Table, …) · dashboard/ · compose/ · providers/
    hooks/       polling + debounce
    lib/         API client, session, CSV parsing, formatting
    types/       API contracts
samples/         leads-25.csv, leads-1000.csv
```

---

## 3. Google OAuth setup

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID**
2. Application type **Web application**
3. **Authorised JavaScript origins**: `http://localhost:3000`
   (no redirect URI needed — Google Identity Services returns the ID token in-page)
4. Copy the client ID into **both** files:

```ini
# backend/.env
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com

# frontend/.env.local
NEXT_PUBLIC_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
```

**How the login works.** The browser gets a Google **ID token** and posts it to
`POST /api/auth/google`. The backend verifies it against Google's JWKS with
`google-auth-library` (checking signature, audience and expiry), upserts the user, and
returns its **own** JWT which the dashboard sends as `Authorization: Bearer …`. The Google
token is never trusted client-side and never becomes the session.

---

## 4. Ethereal Email setup

Ethereal is a fake SMTP service: it accepts every message, delivers none, and gives you a
web page per message. Nothing needs to be created by hand:

```bash
npm --prefix backend run senders:create
```

This provisions `ETHEREAL_SENDER_COUNT` (default **3**) independent mailboxes, stores them in
the `senders` table, and prints their credentials. Log in at
<https://ethereal.email/login> with any of them to read what was "sent" — or just click
**View message** in the Sent tab, which opens that message's Ethereal preview URL
(captured from `nodemailer.getTestMessageUrl` and stored on the row).

Prefer your own SMTP? Set `SMTP_ACCOUNTS` to a JSON array instead:

```ini
SMTP_ACCOUNTS=[{"label":"sender-1","host":"smtp.example.com","port":587,"user":"u","pass":"p","maxEmailsPerHour":80}]
```

> The API also provisions mailboxes automatically on first boot if the pool is empty, so a
> fresh clone can schedule mail without this step.

---

## 5. Architecture

### 5.1 How scheduling works

**Postgres owns *what* must be sent. Redis owns *when* it runs.** Everything else follows
from that split.

`POST /api/emails/schedule` does four things:

1. **Normalise the list** — parses the CSV/text, lower-cases, validates, and de-duplicates
   while preserving order (order becomes the send `sequence`).
2. **Plan the send times** — `planSendTimes()` in
   [`scheduler.service.ts`](backend/src/services/scheduler.service.ts) turns
   `(count, startAt, delay, hourlyLimit)` into one timestamp per recipient. Emails fill the
   first rate-limit window spaced by `delay`, then spill into the next window:

   ```
   at(i) = max( start + i·delay ,  start + ⌊i/limit⌋·window + (i mod limit)·delay )
   ```

   The `max` keeps the series monotonic when the spacing itself is the binding constraint
   (e.g. a 5-minute delay under a 500/hour cap).
3. **Persist** — one `INSERT … SELECT FROM unnest(...)` per 1 000 recipients, so 10 000
   leads is a handful of round trips rather than 10 000 inserts. Each row carries a unique
   `idempotency_key` of `campaign_id:email`.
4. **Enqueue** — `queue.addBulk()` with `jobId = email_jobs.id` and
   `delay = scheduled_at − now`.

Enqueueing happens **after** the transaction commits. If the process dies in between, the
rows exist as `scheduled` and the boot reconciler re-adds them: the failure mode is a *late*
send, never a lost or duplicated one.

### 5.2 What the worker does per job

```
claim row  ──►  resolve sender  ──►  hourly quota  ──►  pace slot  ──►  SMTP  ──►  mark sent
   │                                      │
   │ already sent/cancelled → no-op       │ no quota anywhere → defer to next window
   └──────────────────────────────────────┘
```

1. **Claim** — `UPDATE … SET status='processing' WHERE id=$1 AND status IN ('scheduled','rate_limited','processing')`.
   A row that is already `sent`, `cancelled` or permanently `failed` returns nothing and the
   job becomes a no-op. This single conditional update is the idempotency gate.
2. **Reserve hourly quota** — tries the sender assigned at schedule time, then falls over to
   any other sender with quota left (that is the point of running a pool).
3. **Reserve a pace slot** — see §5.4.
4. **Send** via a pooled nodemailer transport, then record `sent_at`, `dispatched_at`,
   `message_id` and the Ethereal `preview_url`.
5. **On failure** — refund the hourly slot (no mail left, so no quota was consumed),
   increment `attempts`, and let BullMQ retry with exponential backoff until
   `EMAIL_MAX_ATTEMPTS`, after which the row is `failed`.

### 5.3 Persistence across restarts

Three layers, in order of how often they matter:

| Layer | Covers |
|---|---|
| Redis AOF (`--appendonly yes` in `docker-compose.yml`) | Redis restarts — the delayed set is on disk |
| BullMQ delayed set | API/worker restarts — jobs keep firing at their original time |
| **Boot reconciler** ([`reconciler.ts`](backend/src/queue/reconciler.ts)) | Redis wiped/replaced, process killed between COMMIT and enqueue, worker killed mid-send |

On boot (and via `POST /api/system/reconcile`) the reconciler:

- releases rows stuck in `processing` for longer than `STALE_PROCESSING_MS` (a worker died
  mid-send) back to `scheduled`;
- loads every `scheduled` / `rate_limited` row, checks whether a live queue job still exists
  for its id, and re-adds the missing ones **with their original `scheduled_at`**.

Nothing restarts "from day 1": each row keeps its own send time, and only genuinely overdue
mail goes out immediately. Re-adding is safe because the queue job id *is* the row id —
BullMQ ignores an `add` for a job it already has, and the claim in §5.2 catches anything else.

**Verified end-to-end** (see §8): killed the API mid-campaign → restarted → the remaining
emails went out, `attempts = 1`, no duplicates. Then `redis-cli FLUSHALL` → restarted →
reconciler reported `requeued: 3` and all three fired at their **original** timestamps.

### 5.4 Concurrency, minimum delay, and hourly limits

Three independent controls, all enforced in Redis so they hold across every worker process:

**① Worker concurrency — `WORKER_CONCURRENCY` (default 5)**
How many sends one worker process may have in flight. Concurrency exists so a slow SMTP
round trip does not block the next send; it is *not* a throughput dial, because ② and ③ still
gate every send. All shared state is in Postgres/Redis, so parallel jobs are safe.

**② Minimum delay between sends — `MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000 ms)**
Two mechanisms, deliberately:

- *BullMQ's limiter* (`limiter: { max: RATE_LIMIT_BURST, duration: MIN_DELAY_BETWEEN_EMAILS_MS }`)
  throttles how fast jobs enter the processor, fleet-wide.
- *An exact pacer* ([`pacer.service.ts`](backend/src/services/pacer.service.ts)). BullMQ's
  limiter is a **fixed window**: with `max: 1` over 2 s, a job at t=1.9 s and the next at
  t=2.1 s are both allowed, so two emails can leave 200 ms apart. Since the promise is a
  *minimum gap*, each worker also atomically reserves the next free slot from a shared Redis
  ledger (`GET` → `max(now, next)` → `SET next+spacing`, in one Lua script) and waits until
  it. Waits longer than `max(15 s, 2× spacing)` are handed back to the queue via
  `moveToDelayed` instead of parking a concurrency slot on a sleep.

  Measured with 6 emails all scheduled for the same instant, `MIN_DELAY=2000`:

  ```
  dispatched            gap
  15:17:16.524          (first)
  15:17:18.523          2.00s
  15:17:20.523          2.00s
  15:17:22.530          2.01s
  15:17:24.535          2.00s
  15:17:27.572          3.04s   ← never below the minimum
  ```

  `dispatched_at` records when the message was handed to SMTP; `sent_at` records completion.
  With `WORKER_CONCURRENCY > 1` completions interleave (a slow send finishes after a later,
  faster one) — that is expected, and why the guarantee is expressed on dispatch.

**③ Hourly limits — `MAX_EMAILS_PER_HOUR`, `MAX_EMAILS_PER_HOUR_PER_SENDER`**
Fixed-window counters in Redis keyed by `…:rl:{scope}:{windowStart}`, checked **and**
incremented in a single Lua script so two workers can never both take the last slot. Both
the global and the per-sender counter are evaluated in that one script. A `senders` row may
override the per-sender cap (`max_emails_per_hour`) — useful for a mailbox still warming up.

Set either to `0` to disable it. `RATE_LIMIT_WINDOW_MS` controls the window length: keep
`3600000` in production, drop it to `60000` to demo an "hourly" limit in a minute.

**When the limit is hit, nothing is dropped or failed.** The job is moved to the next window
with `moveToDelayed` + `DelayedError` (which does *not* consume a retry attempt), the row
becomes `rate_limited`, `defer_count` increments, and the dashboard shows
*"Hourly cap reached — moved to the next window"*. Order is preserved by deriving the offset
inside the new window from the job's `sequence`, and BullMQ drains delayed jobs in timestamp
order.

Measured with `MAX_EMAILS_PER_HOUR_PER_SENDER=1`, 3 senders, 6 emails, 60 s window:

```
rl0  sent          deferrals:0   dispatched 15:18:26   ethereal-1
rl1  sent          deferrals:0   dispatched 15:18:26   ethereal-2
rl2  sent          deferrals:0   dispatched 15:18:27   ethereal-3
rl3  sent          deferrals:1   dispatched 15:19:00   ethereal-1   ← next window
rl4  sent          deferrals:1   dispatched 15:19:00   ethereal-2
rl5  sent          deferrals:1   dispatched 15:19:01   ethereal-3
```

### 5.5 Behaviour under load (1000+ emails for the same time)

- **Scheduling** is bulk: ~1 000 rows per `INSERT … unnest`, 500 jobs per `addBulk`.
  Scheduling 1 000 recipients takes well under a second and produces 1 000 delayed jobs.
- **The plan already spreads them.** With `hourlyLimit=200`, recipients 0–199 land in the
  first window, 200–399 in the second, and so on — the queue is not asked to absorb a
  thundering herd it will only reject.
- **If they still all come due at once** (e.g. `hourlyLimit=0` with a past start time),
  BullMQ's limiter admits them at the paced rate, the pacer spaces the ones it admits, and
  the hourly counters push the overflow into later windows. Steady state is
  `min(1 / minDelay, hourlyLimit × senders / window, globalLimit / window)`.
- **Memory stays flat** — jobs live in Redis, not in the process; the worker holds at most
  `WORKER_CONCURRENCY` rows at a time.

Try it:

```bash
npm --prefix backend run seed:load -- --count 1000 --delay 500 --hourly 50 --startIn 10
```

### 5.6 Idempotency — the four guards

1. `email_jobs.idempotency_key` is `UNIQUE`; the bulk insert uses `ON CONFLICT DO NOTHING`,
   so a recipient can appear once per campaign.
2. The BullMQ **job id is the row id**, so the queue itself de-duplicates `add` calls.
3. The worker's **conditional claim** refuses to send a row that is not pending.
4. `campaigns (user_id, idempotency_key)` is unique — replaying a whole schedule request
   (double-click, network retry) returns the original campaign instead of creating a second.
   The dashboard sends a fresh `crypto.randomUUID()` per compose.

---

## 6. API

All routes except `/api/health` and `/api/auth/*` need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness + Postgres/Redis checks |
| `POST` | `/api/auth/google` | Exchange a Google ID token for a session token |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/emails/schedule` | Schedule a campaign |
| `GET` | `/api/emails?group=scheduled\|sent\|all` | Paginated list (`page`, `pageSize`, `search`, `status`) |
| `GET` | `/api/emails/stats` | Counts for the stat cards |
| `GET` | `/api/emails/:id` | One email |
| `POST` | `/api/emails/:id/cancel` | Cancel a pending email |
| `GET` | `/api/campaigns` · `/api/campaigns/:id` | Campaigns with progress |
| `POST` | `/api/campaigns/:id/cancel` | Cancel everything still pending |
| `GET` | `/api/senders` | Sender pool + current window usage |
| `POST` | `/api/senders` · `/ethereal` · `/bootstrap` · `/:id/verify` · `/:id/toggle` | Manage the pool |
| `GET` | `/api/system/throughput` | Live limits, queue depth, per-sender usage |
| `POST` | `/api/system/reconcile` | Re-run the boot reconciliation |

Errors always come back as `{ "error": { "code", "message", "details? } }`.

### Trying it without a browser

`npm --prefix backend run dev:token` mints a session token for a local user (it is a CLI
script, not an HTTP route — there is no way to obtain one over the network):

```bash
TOKEN=$(npm --prefix backend run dev:token --silent | grep '^token' | awk '{print $2}')

curl -X POST http://localhost:4000/api/emails/schedule \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "subject": "Hello from ReachInbox",
    "body": "Hi there,\n\nScheduled by BullMQ.",
    "startAt": "2026-08-20T15:30:00.000Z",
    "delayBetweenEmailsMs": 2000,
    "hourlyLimit": 100,
    "recipientsText": "email,name\nada@example.com,Ada\ngrace@example.com,Grace"
  }'

curl "http://localhost:4000/api/emails?group=sent" -H "Authorization: Bearer $TOKEN"
```

`recipientsText` accepts a raw CSV/newline paste; `recipients` accepts
`["a@b.com"]` or `[{"email":"a@b.com","name":"A"}]`. `startAt` defaults to now, and a start
time in the past is clamped to now (the response flags `startAtAdjusted`).

---

## 7. Configuration

Every value below is read once at boot by [`config/env.ts`](backend/src/config/env.ts),
which fails loudly on a malformed value. Nothing else in the codebase touches `process.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | API port |
| `CORS_ORIGIN` | `http://localhost:3000` | Comma-separated allowed origins |
| `DATABASE_URL` | — | **Required.** Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `QUEUE_PREFIX` | `reachinbox` | Namespace for all BullMQ/limiter keys |
| `GOOGLE_CLIENT_ID` | — | OAuth client id (login is disabled without it) |
| `JWT_SECRET` | dev fallback | **Required in production.** Signs session tokens |
| `WORKER_CONCURRENCY` | `5` | In-flight sends per worker process |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | Minimum gap between sends |
| `RATE_LIMIT_BURST` | `1` | Sends the BullMQ limiter allows per gap window |
| `RUN_WORKER_INLINE` | `true` | Run a worker inside the API process |
| `MAX_EMAILS_PER_HOUR` | `500` | Global hourly cap (`0` = off) |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `100` | Per-mailbox hourly cap (`0` = off) |
| `RATE_LIMIT_WINDOW_MS` | `3600000` | Window length — lower it to demo |
| `EMAIL_MAX_ATTEMPTS` / `EMAIL_BACKOFF_MS` | `3` / `5000` | Retry policy |
| `MAX_RECIPIENTS_PER_CAMPAIGN` | `10000` | Request guard |
| `RECONCILE_ON_BOOT` | `true` | Rebuild the queue from Postgres on start |
| `STALE_PROCESSING_MS` | `120000` | After this, an in-flight row is treated as orphaned |
| `ETHEREAL_SENDER_COUNT` | `3` | Mailboxes `senders:create` provisions |
| `SMTP_ACCOUNTS` | — | JSON array of real SMTP accounts instead of Ethereal |

---

## 8. Features implemented

### Backend

| Requirement | Status | Where |
|---|---|---|
| Accept scheduling requests via API | ✅ | `POST /api/emails/schedule`, zod-validated |
| Store in a relational DB | ✅ | Postgres, plain-SQL migrations (`db/migrations`) |
| Schedule with BullMQ delayed jobs, **no cron** | ✅ | `queue/enqueue.ts` — `addBulk` + `delay` |
| Send via Ethereal SMTP from multiple senders | ✅ | `senders` table, round-robin + quota failover |
| Survive restarts, no duplicates, no restart-from-scratch | ✅ | `queue/reconciler.ts` + conditional claim |
| Configurable worker concurrency | ✅ | `WORKER_CONCURRENCY` |
| Parallel-safe job handling | ✅ | All shared state in Postgres/Redis; atomic claim |
| Minimum delay between sends | ✅ | BullMQ limiter **+** exact Redis pacer (§5.4) |
| Hourly rate limit, global **and** per-sender | ✅ | Redis Lua counters, per-sender DB override |
| Limits configurable, never hardcoded | ✅ | `config/env.ts` |
| Multi-worker / multi-instance safe | ✅ | Redis-backed counters, limiter and pacer |
| Rate-limited jobs deferred, not dropped | ✅ | `moveToDelayed` to the next window, order preserved |
| Idempotency | ✅ | Four independent guards (§5.6) |
| Retries with backoff and a terminal `failed` state | ✅ | `EMAIL_MAX_ATTEMPTS`, exponential backoff |
| Graceful shutdown | ✅ | Drains in-flight sends before exit |
| Health checks | ✅ | `GET /api/health` |

### Frontend

| Requirement | Status | Notes |
|---|---|---|
| Real Google OAuth (no mock) | ✅ | GIS ID token verified server-side, then an app JWT |
| Redirect to dashboard after login | ✅ | Guarded routes both ways |
| Header with name, email, avatar | ✅ | Plus a logout menu |
| Logout | ✅ | Clears session; a 401 also signs you out automatically |
| Scheduled / Sent tabs | ✅ | With live counts |
| Compose New Email button | ✅ | Opens a modal |
| Compose: subject + body | ✅ | Validated |
| Compose: upload CSV/TXT, show address count | ✅ | Drag-and-drop; parses CSV or plain lists |
| Compose: start time, delay, hourly limit | ✅ | Defaults pulled from the API's own config |
| Schedule to the backend API | ✅ | With a per-compose idempotency key |
| Scheduled table: email, subject, time, status | ✅ | Plus sender, relative time, cancel |
| Sent table: email, subject, sent time, status | ✅ | Plus a link to the Ethereal message |
| Loading states | ✅ | Skeleton rows, button spinners, silent refreshes |
| Empty states | ✅ | Per tab, with a call to action |
| Error handling | ✅ | Toasts, inline field errors, typed `ApiError` |
| Reusable components, DRY, typed | ✅ | `components/ui/*`, one API client, shared types |

Extras beyond the brief: a live throughput panel (limits, window usage, queue depth,
per-sender consumption), search, pagination, per-email and per-campaign cancel, a
`dispatched_at` audit field, and `POST /api/system/reconcile` for demoing recovery.

---

## 9. Demo script

Make the limits observable first, in `backend/.env`:

```ini
RATE_LIMIT_WINDOW_MS=60000
MAX_EMAILS_PER_HOUR_PER_SENDER=1
MIN_DELAY_BETWEEN_EMAILS_MS=2000
```

1. **Login** — Google sign-in, then the dashboard with your name, email and avatar.
2. **Compose** — upload `samples/leads-25.csv`, watch the "25 email addresses detected"
   counter, set a start time a minute out, hit **Schedule**.
3. **Scheduled tab** — 25 rows with exact send times; the throughput panel shows the queue.
4. **Sent tab** — rows appear about 2 s apart; **View message** opens the Ethereal preview.
5. **Rate limiting** — after 3 sends the rest flip to *Rate limited — moved to the next
   window*, then drain when the window rolls over.
6. **Restart** — `Ctrl-C` the API, wait, restart. The reconciler logs
   `Reconciliation complete {released, requeued, pending, overdue}` and the remaining emails
   still go out, once each. For the dramatic version run
   `docker exec reachinbox-redis redis-cli FLUSHALL` first — the queue is rebuilt from
   Postgres and the original send times are honoured.
7. **Load** — `npm --prefix backend run seed:load -- --count 1000 --delay 500 --hourly 50`,
   then watch queue depth and the per-sender usage bars.

---

## 10. Assumptions, shortcuts and trade-offs

**Assumptions**

- *No Figma file was attached to the brief I received*, so the UI is an original dark
  dashboard built to the written spec — header with user info, tabs, compose modal, both
  tables, loading and empty states. Every element the brief lists is present; the visual
  language is my own.
- One email body for all recipients — no per-lead merge tags. `recipient_name` is parsed and
  stored, so templating is an addition rather than a redesign.
- Senders form a shared pool rather than belonging to individual users; a real tenant model
  would scope `senders` by `user_id`.
- Times are stored as `timestamptz` and rendered in the browser's local zone.

**Trade-offs**

- **At-least-once, not exactly-once.** If a worker is killed *after* SMTP accepts a message
  but *before* the row is marked `sent`, BullMQ's stalled-job recovery re-delivers it and the
  mail goes out twice. `lockDuration` (60 s) sits well above the SMTP socket timeout (30 s)
  to make that rare, and the conditional claim closes every other window. True exactly-once
  needs provider-side deduplication on a stable `Message-ID`, which Ethereal cannot
  demonstrate.
- **Fixed windows, not sliding.** Quotas reset on the wall-clock boundary, so a burst
  straddling two windows can send `2 × limit` within one rolling hour. A sliding window
  (sorted set of send timestamps) is stricter but costs a `ZREMRANGEBYSCORE` + `ZCARD` per
  send; for provider-style "N per hour" caps the fixed window is the conventional choice.
- **Session tokens live in `localStorage`.** Simple and CSRF-free, at the cost of XSS
  exposure. Production would use an httpOnly refresh cookie with short-lived access tokens.
- **SMTP credentials are stored in plaintext** in the `senders` table. Fine for throwaway
  Ethereal mailboxes; real credentials belong in a secrets manager or encrypted at rest.
- **Reconciliation runs at boot and on demand, not on a timer.** A periodic sweep would be
  the natural next step, but every primitive available for it (`repeat`, `every`, an
  interval) is cron-shaped and the brief rules that out. Boot plus a manual endpoint covers
  the failure modes without bending the constraint.
- **The reconciler checks jobs one id at a time** (batched 200-wide with `Promise.all`)
  rather than reading BullMQ's internal Redis keys. Slower on a very large backlog, but it
  only uses the public API.
- **Lead parsing is duplicated** between `backend/src/utils/recipients.ts` and
  `frontend/src/lib/leads.ts`: the composer needs a live count before upload and the API
  cannot trust the client. A shared workspace package would remove the copy; for two small
  functions it was not worth the monorepo tooling.
- **No automated test suite.** Inside the 48-hour window I spent the time verifying the hard
  guarantees by hand instead (the measurements in §5.3 and §5.4 are real runs, not
  illustrations). `planSendTimes`, `parseRecipientsText`, `normalizeRecipients` and the Lua
  scripts are deliberately pure and isolated so they are straightforward to unit-test.

---

## 11. Scripts

| Command | What it does |
|---|---|
| `npm run infra:up` / `infra:down` | Postgres + Redis via Docker |
| `npm run install:all` | Install backend and frontend |
| `npm run dev:api` / `dev:worker` / `dev:web` | Run each process |
| `npm run build` | Compile the backend, build the frontend |
| `npm run typecheck` | Typecheck both apps |
| `npm --prefix backend run migrate` | Apply SQL migrations |
| `npm --prefix backend run senders:create` | Provision Ethereal mailboxes |
| `npm --prefix backend run dev:token` | Mint a session token for curl/Postman |
| `npm --prefix backend run seed:load -- --count 1000` | Schedule a load-test campaign |

---

## 12. Running everything in Docker

```bash
cp backend/.env.example backend/.env      # set GOOGLE_CLIENT_ID and JWT_SECRET
docker compose --profile app up -d --build
```

That builds the backend image and runs the API and the worker as separate containers against
the same Postgres and Redis — which is also the quickest way to see the shared limiter and
hourly counters keeping two independent worker processes inside one budget.
