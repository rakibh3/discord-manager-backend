## Context

Phase 6 is the last piece of the nightly loop. The channel opens and locks on a schedule, submissions arrive through the form and through `#daily-update`, and `dailyStatusRepository.listMembersMissingUpdate(date)` already answers "who did not post". The reminder tables were written in the attendance data-model change and have never held a row. This change connects the two.

The constraints it works inside:

- **Golden Rule 4 — never burst DMs.** Discord's per-bot DM limits are not published as a hard number and are enforced with 429s escalating to a temporary or permanent ban. A loop over 5,000 members is not "slow", it is a bot outage — and because the bot is one process, that outage takes member sync with it, and the attendance form's membership check with that.
- **Golden Rule 1 — DM by snowflake.** `discord_user_id`, never the handle. Handles are mutable; the reminder would reach whoever holds the old one.
- **One process, now four subsystems.** Express, the gateway client, the channel scheduler, and now a queue worker. `client.ts` is documented as never throwing and the scheduler inherits that contract; the worker inherits it too, in both directions.
- **Not HTTP-scoped.** A queue job has no `req` to fail and no `AppError` to throw. Data access belongs in `src/repositories/`, which is exactly why `reminder.repository.ts` was written there in the first place — its docstring names the BullMQ worker as its primary caller.
- **A broadcast is irreversible and public.** 5,000 people receive a message. There is no unsend. Every design choice below that looks conservative — an explicit date, a cancel path, a refusal to run two at once — is paying for that.
- **The reminder tables are already right.** `ReminderRecipient` has a `PENDING` default and a `(reminder_id, member_id)` unique key, `finalizeReminderLog()` already recomputes counts from the recipient rows. This change should use that design rather than reinterpret it.

## Goals / Non-Goals

**Goals:**

- An administrator can remind every member missing a daily update for a given Dhaka date, with a message they wrote, without any risk of the bot being rate limited or banned.
- Every targeted member has exactly one recorded outcome, and that record survives a process restart mid-broadcast.
- A member whose DMs are closed is still reached, through the fallback channel mention.
- A broadcast in flight can be stopped.
- A broadcast that is stalled, failing, or unable to reach Redis is visible to an administrator rather than only in the logs.
- Redis being down degrades reminders and nothing else.

**Non-Goals:**

- The SSE progress stream. It belongs with the dashboard API in Phase 7, designed against the rest of the dashboard's live state rather than bolted onto this change. The polled progress read lands here and is what the SSE endpoint will wrap.
- Any automatic trigger. No cron, no "send at 12:05 AM if nobody clicked". A mass DM is a human decision every time.
- Retrying a whole broadcast, or a "resend to the ones that failed" action. A new broadcast for the same date does that, and the target list is recomputed at that moment — which is more correct than replaying a stale one.
- CSV/Excel export of reminder history (Phase 7's export work covers the domain uniformly).
- Moving the public attendance rate limiters onto Redis. Same reasoning as the proposal: opposite failure directions, separate decision.
- Reminding about missing *attendance*. The PID's reminder is specifically for missing daily updates, and `listMembersMissingUpdate` is the list that exists.

## Decisions

### 1. BullMQ's worker rate limiter, not a hand-rolled sleep

The worker is constructed with `limiter: { max: <REMINDER_DM_PER_SECOND>, duration: 1000 }`, defaulting to `2`. One job sends one DM; the limiter paces the jobs.

The alternative — one job that loops over all recipients with an `await sleep(500)` — puts a 40-minute unit of work in a single job. Anything that interrupts it (a deploy, a crash, an OOM) loses the position, and BullMQ's stall detection would eventually re-run the whole thing from the start, re-DMing everyone already reminded. One job per recipient makes the unit of retry the unit of work, which is the entire reason to use a queue rather than a `setInterval`.

The limiter's counter lives in Redis and is shared by every worker on the queue, so the budget is global rather than per-process. That is a meaningful difference from `node-cron`: adding a second replica does not double the DM rate the way it doubles the scheduler's announcements.

*Alternative rejected:* BullMQ's manual `worker.rateLimit(duration)` + `RateLimitError` as the primary mechanism. That pattern is for reacting to an external service's 429. discord.js already queues and retries internally on its own rate-limit buckets, so we would rarely see one — the fixed limiter's job is to stay far enough below the limit that we never do. The manual path stays available if a 429 ever does surface (decision 6).

### 2. Recipient rows are written before any job is enqueued

`POST /api/reminders/send` does, in order: resolve the target list, create the `reminder_logs` row with `targetCount`, `createMany` the `reminder_recipients` rows in `PENDING`, then bulk-enqueue the jobs and return `202`.

Writing the recipients first means the database knows the full intended target set before a single DM exists, so a crash between enqueue and delivery leaves a broadcast that is *visibly incomplete* (N rows still `PENDING`) rather than a broadcast that looks finished because only what was delivered was ever recorded. `finalizeReminderLog()` was already written to treat leftover `PENDING` rows as a failed run for exactly this reason.

The response is `202 Accepted` with the reminder id, not `200` with a result. Nothing is delivered yet when the request returns, and saying otherwise would be a lie the dashboard would render.

### 3. The job payload carries identity, not content

Job data is `{ reminderId, memberId, discordUserId }`. The message text is read from the `reminder_logs` row inside the job.

The message is the audit record. Copying it into 5,000 Redis payloads creates 5,000 chances for the delivered text to disagree with the recorded text — and makes cancel-by-editing impossible to reason about. Reading it back is one primary-key lookup per job, at two jobs per second.

`discordUserId` is carried rather than looked up because it is the one field the send genuinely needs and it is immutable, so a payload can never be stale in a way that matters.

### 4. Closed DMs are an outcome, not a failure

The job catches Discord's error codes and maps them:

| Condition | Recipient outcome | BullMQ |
| --- | --- | --- |
| Sent | `DELIVERED` | job succeeds |
| `50007` Cannot send messages to this user | `DM_CLOSED` | job **succeeds** |
| `10013` Unknown User (deleted account) | `FAILED` | job succeeds |
| Missing access / forbidden | `FAILED` | job succeeds |
| Network error, Discord 5xx, timeout | left `PENDING` | job **throws**, retried |
| Attempts exhausted | `FAILED` | job fails terminally |

A closed DM is not an error — it is a fact about that member, and the fallback announcement is the system's answer to it. Throwing would make BullMQ retry three times against a condition that cannot change, then leave a "failed" job that is really a successful determination. Only conditions that could plausibly succeed on a second try throw.

`attempts: 3` with `backoff: { type: 'exponential', delay: 2000 }` — 2s, 4s, 8s. The `failed` event handler writes the `FAILED` outcome when attempts run out, so a job that dies for a reason the processor never saw still produces a recipient row rather than an eternal `PENDING`.

### 5. At-least-once, narrowed by a pre-send status check

BullMQ is at-least-once. If the DM sends and the outcome write then fails, the retry re-sends. There is no distributed transaction across Discord and Postgres to prevent it.

What the design does instead:

- `jobId` is `` `${reminderId}:${memberId}` ``, so an accidental double enqueue is deduplicated by Redis before it ever runs.
- The job re-reads its recipient row first and returns immediately if it is no longer `PENDING`. That closes the common window: a retry after a *recorded* success does nothing.
- The `(reminder_id, member_id)` unique key means a duplicate row is impossible regardless.

The residual window is "DM sent, process died before the outcome write". A member receives the reminder twice. That is the correct failure to accept here — the alternative (record first, then send) turns the same window into a member who is recorded as reminded and never was, and the whole point of the feature is that they get reminded.

### 6. Discord rate limits are discord.js's problem first

discord.js queues requests per rate-limit bucket and handles 429s internally, so the worker should almost never see one. If a `429` does surface, the job calls `worker.rateLimit(retryAfterMs)` and throws `Worker.RateLimitError()` — BullMQ's documented signal that the job goes back to `wait` without counting as a failure, and the whole worker pauses for the duration. Getting this distinction wrong is how a rate-limit event turns into three retries per job and a spent attempt budget across the entire remaining broadcast.

### 7. Drain is detected in the database, with an atomic latch

There is no reliable per-broadcast "queue is empty" event — BullMQ's `drained` is queue-wide, and with two broadcasts in the same queue it means nothing about either. Instead, after each job records its outcome, the worker counts recipients still `PENDING` for that `reminderId`. At zero, the broadcast is finished.

Two jobs can reach zero concurrently, so finalization is claimed atomically: an `updateMany` on `{ id, status: PROCESSING }` → `COMPLETED`/`FAILED`. Only the caller that sees `count === 1` runs the fallback announcement and the count reconciliation. Without the latch, two workers post two mass mentions to a channel students read.

This also means `finalizeReminderLog()` gains a status precondition. It currently updates unconditionally, which was correct when nothing else could race it.

### 8. The fallback announcement is chunked, with explicit `allowedMentions`

Once claimed, the finalizer lists `DM_CLOSED` recipients and posts to `REMINDER_CHANNEL_ID` in chunks sized to stay under Discord's 2,000-character message limit — a mention is `<@` + a 17–20 digit snowflake + `>`, so chunks are capped by a conservative count rather than by measuring the string after the fact.

Every message sets `allowedMentions: { parse: [], users: <the ids in this chunk> }`. `parse: []` is the part that matters: it makes `@everyone`, `@here`, and role pings structurally impossible from this code path, whatever ends up in the surrounding text. A bug that pings 5,000 people in a channel is not a bug you get to fix quietly.

A failed announcement does not fail the broadcast — the DMs already went out. It is logged and recorded in the queue runtime state the status endpoint reports, because the alternative is a missing `Send Messages` permission that nobody notices for a month.

### 9. `date` is required, never inferred

`POST /api/reminders/send` requires `date` as a `YYYY-MM-DD` Dhaka date, validated by the existing `dhakaDateSchema`, and rejects a future date.

Defaulting is tempting — the run happens at 12:05 AM and "yesterday" is almost always right. But "almost always" spanning a midnight boundary, on an action that DMs thousands of people, is a bad trade: an admin who clicks at 11:58 PM with a default of "yesterday" reminds the wrong day's stragglers, and nothing about the result would look wrong. The dashboard always knows which date it is displaying and passes it. The one place ambiguity is cheap — the preview endpoint — is where an admin confirms the count before committing.

### 10. One broadcast per date in flight, refused not queued

`send` refuses with a 409 when a broadcast for the same date is already `PENDING` or `PROCESSING`. A second broadcast for a date whose earlier run has finished is allowed, with a freshly computed target list.

Refusing is better than queueing behind the first: a double-click on a button that takes 40 minutes to complete should not schedule a second 40-minute mass DM. And a genuine second reminder later in the night is a deliberate act whose targets should be recomputed, not replayed — members who posted in between must drop out.

### 11. Cancel works by session status, not by removing jobs

`POST /api/reminders/:id/cancel` sets the session to `CANCELLED`, then makes a best-effort pass removing that reminder's waiting jobs from Redis. The worker re-reads the session status before every send and returns without sending if it is `CANCELLED`.

Job removal alone is not a cancel: a job already in `active` cannot be removed, and removal is a race against the worker. The status check is the actual mechanism and the removal is an optimization that stops Redis from grinding through thousands of no-ops. Recipients never attempted stay `PENDING`, and the read reports "cancelled, N never attempted" — which is the truth, and is why `CANCELLED` is a new enum value rather than a reuse of `FAILED`.

*Alternative rejected:* deleting the recipient rows on cancel. That erases the record of who *was* targeted, which is exactly what an admin cancelling a mistaken broadcast will want to see afterwards.

### 12. The worker runs in the API process, started after the gateway is ready

The worker needs a logged-in Discord client to send a DM, and that client lives in this process. A separate worker process would need its own gateway login — a second connection, a second member cache, and a second thing that can hit an intent problem.

It starts from the same `onDiscordReady()` hook the scheduler uses, for the same reason: a worker that starts before the gateway is ready pulls jobs it cannot execute and burns their attempts. If the bot never connects, the worker never starts and `GET /api/reminders/status` says so.

`REMINDER_WORKER_ENABLED` gates it, mirroring `SCHEDULER_ENABLED` — but for a different reason, and the difference is worth recording. The scheduler flag exists because `node-cron` is process-local and N replicas produce N announcements. The queue's limiter is Redis-backed and global, so N workers stay inside one DM budget; the flag is there for operational control (draining a node, isolating the worker later) rather than correctness.

### 13. Redis failure is contained to reminders

The connection is created once in `src/lib/queue/connection.ts` with `maxRetriesPerRequest: null`, which BullMQ requires of worker connections so a transient Redis outage retries instead of throwing the worker to death. Connection errors are logged, never thrown.

Startup does not require Redis: if the connection fails, the queue and worker are not started, every `/api/reminders` write returns `503` with a message naming Redis, and the API, the bot, ingestion, the attendance form, and the channel scheduler are untouched. Redis is a dependency of one feature, and that is how it is wired.

### 14. Routes live in a new `/api/reminders` module, admin only

A `src/modules/reminder/` following the four-file pattern, mounted in `app.ts`, every route behind `auth(UserRole.ADMIN)`:

- `GET /targets?date=` — the target list and count, for the confirm-before-send step.
- `POST /send` — `{ date, message }` → `202` with the reminder id and target count.
- `GET /` — broadcast history, paginated.
- `GET /:id` — one session with live counts and the per-status breakdown. This is what Phase 7's SSE endpoint will stream.
- `GET /:id/recipients` — paginated recipient outcomes, filterable by status; the audit view.
- `POST /:id/cancel` — stop a broadcast in flight.
- `GET /status` — worker running, Redis reachable, queue depth, the last fallback announcement's outcome.

The service layer keeps throwing `AppError`; the queue modules under `src/lib/queue/` contain none, exactly like the gateway handlers and the scheduler.

### 15. `sendMemberDm` is the only DM sender

`src/lib/discord/dm.ts` owns both outbound paths — the individual DM and the fallback channel post — and returns a discriminated result rather than throwing. The worker classifies; the module transports. Keeping the Discord API surface in one file is what makes the error-code table in decision 4 a single place to change when Discord adds another code, rather than something to grep for.

## Risks / Trade-offs

- **A member receives the same reminder twice** → Accepted, in the narrow window of decision 5 (sent, then the process died before recording). Mitigated by the pre-send status check and by `jobId` deduplication. The inverse design would silently *skip* people, which is worse for a feature whose entire purpose is reaching them.

- **Redis is unavailable when an admin clicks send** → The request fails with a `503` naming Redis rather than half-starting a broadcast. Mitigated by creating the session row only after the queue accepts the jobs is not possible (the rows must exist first, decision 2), so the send path checks queue readiness *before* writing anything. A session with rows and no jobs is the one state that looks finished and is not.

- **A broadcast is interrupted mid-run by a deploy** → Jobs survive in Redis and resume when the worker returns; the session stays `PROCESSING`. Mitigated by the graceful `worker.close()` on shutdown, which lets the in-flight job finish. If the process is killed hard, BullMQ's stall detection returns the job to the queue and the pre-send status check keeps the re-run from re-DMing someone already recorded.

- **A broadcast stays `PROCESSING` forever** → If the worker dies and does not come back, nothing finalizes the session and the dashboard shows a run that never ends. Mitigated by `GET /status` reporting worker liveness and queue depth next to it, and by cancel being available as the manual way out. Not fully solved: a stalled-run sweeper is deliberately not in this change, because the honest fix is an operator noticing the worker is down.

- **The bot lacks Send Messages on `#daily-update-reminder`** → The DMs go out and the fallback silently reaches nobody. Mitigated by reporting the failure on `GET /api/reminders/status` and naming the permission in `.env.example` beside the Manage Roles prerequisite. Not preventable at startup: it is a per-channel permission that can be changed at any time.

- **40 minutes of DMs at 2/second for 5,000 members** → The last member is reminded at 12:45 AM. Accepted: the alternative is a banned bot. `REMINDER_DM_PER_SECOND` exists so the rate can be tuned with evidence, and is clamped to a small range so it cannot be set to something that gets the bot banned by typo.

- **A mass mention in the fallback channel** → Up to a few hundred people pinged at once, at night. Mitigated by chunking and by `allowedMentions.parse: []`. The volume itself is what the PID asks for; whoever runs the server can mute the channel.

- **Two replicas both run workers** → Both draw from the same queue under the same Redis-backed limiter, so the DM rate stays correct. The finalization latch (decision 7) is what keeps the fallback announcement single. This is genuinely safer than the scheduler's equivalent situation, and `REMINDER_WORKER_ENABLED` is still there to force the single-worker arrangement.

- **An admin sends a broadcast with a typo** → Cancel stops the rest, but everything already delivered is gone for good. Mitigated by the preview endpoint and by `202` returning the target count immediately. No further mitigation is possible; this is the nature of the action.

## Migration Plan

1. **Discord first:** confirm the bot can send messages in `#daily-update-reminder`. Nothing else in the system needs that channel, so it has never been exercised.
2. `bun add bullmq ioredis`.
3. Add the `redis` service to `docker-compose.yml` and `REDIS_URL` to `.env`; `docker compose up -d` brings it up alongside Postgres.
4. `bunx prisma migrate dev --name add_reminder_cancelled_status` then `bunx prisma generate`. The migration adds one enum value; no row is rewritten.
5. Deploy with `REMINDER_WORKER_ENABLED=true` on the instance that runs the scheduler, and `REMINDER_DM_PER_SECOND` unset (defaults to 2).
6. Verify `GET /api/reminders/status` reports Redis connected and the worker running.
7. **Rehearse on a small target set before the first real run:** pick a date with a handful of missing members, confirm the count with `GET /api/reminders/targets`, send, and watch the progress read reach a terminal state. Confirm the recipient rows, and confirm the fallback posts if any recipient came back `DM_CLOSED`.
8. Then run it for real.
9. **Rollback:** revert the deploy. Any queued jobs stay in Redis and simply never run; the affected sessions stay `PROCESSING` and can be cancelled once the API is back. The enum value can stay — nothing reads it when the feature is off.

## Open Questions

- Should the DM include a link to the attendance form, or only the admin's message? Assumed the admin's message inside a fixed `⚠️ **Daily Update Reminder**` wrapper, matching the PID's sketch. A link belongs in the message text the admin writes, which keeps the copy editable without a deploy.
- Should a member who is missing *both* attendance and their update get different wording? Not in this change — the target list is "no daily update", one message for everyone in it. Two messages means two target lists and two broadcasts, which is a product decision, not a technical one.
- Should broadcast history retain the message text forever? It does today, because `reminder_logs.message` is the audit record. If retention ever becomes a concern, that is a data-retention decision across the whole attendance domain, not a reminder-specific one.
- Does `GET /:id/recipients` need to expose the member's phone and email? Left out for now — it identifies members by handle and display name. The dashboard's user-detail modal (Phase 7) is where contact details belong, behind the same admin auth but in one place rather than two.
