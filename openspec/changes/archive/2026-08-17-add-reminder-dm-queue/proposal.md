## Why

Everything needed to know *who* missed a daily update exists — `listMembersMissingUpdate(date)` returns the list, and `reminder_logs` / `reminder_recipients` are already in the schema waiting to record what happened. Nothing sends anything. The PID's operational timeline (§14) ends at 12:05 AM with an admin clicking **[Send Reminder]**, and that button has no backend.

The naive version of this feature is a `for` loop over 5,000 members calling `user.send()`. Golden Rule 4 exists to forbid exactly that: Discord's DM rate limits would ban the bot partway through, leaving a random subset reminded, no record of which subset, and a dead bot that also stops member sync and the attendance form's membership check. The delivery has to be paced, durable across a restart, and individually recorded — which is what a queue is for, and why this phase is the one that introduces Redis.

## What Changes

- Add **Redis** to the stack (a `docker compose` service and a `REDIS_URL`), and a shared connection factory. This is the project's first Redis dependency.
- Add a **BullMQ queue and worker** for reminder DMs, running in the API process alongside Express, the Discord gateway client, and the channel scheduler. The worker is **rate limited to a configurable 1–2 DMs per second** (default 2), so a 5,000-member broadcast paces out over roughly 40 minutes instead of getting the bot banned in the first second.
- Add **per-recipient delivery recording**: every targeted member gets a `reminder_recipients` row up front in `PENDING`, moved to `DELIVERED`, `DM_CLOSED`, or `FAILED` by the job that handled them. The rows are the audit trail; the counters on the session row stay the cache they were designed to be.
- Handle **closed DMs (`Error 50007`) as an outcome, not a failure** — no retry, no BullMQ job failure, just a `DM_CLOSED` row. Transient failures (network, Discord 5xx) retry three times with exponential backoff.
- Add the **fallback batch announcement**: once a broadcast drains, the members whose DMs were closed are mentioned in chunked messages in `#daily-update-reminder`, with explicit `allowedMentions` so the fallback can never turn into an `@everyone`.
- Add an **admin-only `/api/reminders` module**: preview the target list for a date, trigger a broadcast, read its live progress, page through its recipient outcomes, list past broadcasts, cancel a broadcast in flight, and read queue/worker health.
- Add a **cancel path** for a broadcast already in flight — the stop button for a message sent with a typo to 5,000 people. Adds one `CANCELLED` value to the existing `ReminderStatus` enum; the worker checks the session status before every send, so queued and in-flight jobs stop delivering even if the Redis jobs cannot all be removed in time.
- Add `REMINDER_WORKER_ENABLED` and `REMINDER_DM_PER_SECOND` configuration, and document the bot's **Send Messages** requirement on `#daily-update-reminder`.

Not in scope: the SSE progress stream (Phase 7, with the rest of the dashboard API — the polled progress read lands here so progress is observable in the meantime), any automatic post-midnight trigger (a broadcast is always a human decision), CSV/Excel export of reminder history, and swapping the public rate limiters onto a Redis store (see Impact).

## Capabilities

### New Capabilities

- `reminder-queue-runtime`: The queue infrastructure — the Redis connection, the durable job queue and its worker, the rate limit that makes bulk DMing safe, the retry and backoff policy, at-least-once semantics and the idempotency that survives them, the single-process gating question, containment of queue failures away from the API and the gateway, and shutdown that does not strand an in-flight job.
- `reminder-broadcast`: The admin-facing broadcast session — targeting the members missing a daily update on an explicit Dhaka date, the custom message, the admin-only endpoints that start, observe, cancel, and audit a run, the refusal to run two broadcasts for the same date at once, and the progress and history reporting that make a run's outcome answerable after the fact.
- `reminder-dm-delivery`: What happens to one recipient — the DM addressed by snowflake (Golden Rule 1), the outcome recorded for every targeted member exactly once, closed DMs treated as a recorded outcome rather than an error, and the chunked fallback mention in `#daily-update-reminder` that reaches the members a DM could not.

### Modified Capabilities

- `discord-bot-runtime`: A third non-HTTP subsystem now shares the process. The runtime's startup and shutdown requirements extend to the queue worker — it starts only once the gateway is ready (it cannot DM without a connected client), a Redis outage must not stop the HTTP API, the gateway, or the scheduler any more than they stop each other, and the worker must be closed on `SIGINT`/`SIGTERM` so a DM in flight is not abandoned mid-send. The bot also gains a second channel permission prerequisite — **Send Messages** on `#daily-update-reminder` — which, like Manage Roles on `#daily-update`, must be reported rather than only logged when missing.
- `attendance-data-model`: The reminder session's terminal states gain a cancelled outcome, distinct from a failed one. A broadcast an admin stopped on purpose and a broadcast that stalled with recipients never attempted must not read the same way in the audit trail.

## Impact

**Code**

- `src/lib/queue/connection.ts` (new) — the shared Redis connection, with the worker-safe options BullMQ requires.
- `src/lib/queue/reminder.queue.ts` (new) — the queue, its job payload type, bulk enqueue, and the per-reminder job removal that backs cancel.
- `src/lib/queue/reminder.worker.ts` (new) — the rate-limited worker: one DM per job, outcome recorded, drain detection, and the in-memory runtime state the status endpoint reports.
- `src/lib/discord/dm.ts` (new) — `sendMemberDm()` and the chunked fallback announcement; the only module that sends a DM or writes to `#daily-update-reminder`.
- `src/repositories/reminder.repository.ts` — additions only: an atomic "claim this reminder for finalization" transition so a drain cannot be handled twice, a cancel transition, a pending-count read, a paginated recipient read, and a broadcast history list.
- `src/modules/reminder/*` (new module, four files) — admin-only routes at `/api/reminders`, registered in `src/app.ts`.
- `src/server.ts` — start the worker after the bot is ready, close it during shutdown before the Discord client is destroyed.
- `src/config/index.ts`, `.env.example`, `docker-compose.yml` — Redis service, `REDIS_URL`, `REMINDER_WORKER_ENABLED`, `REMINDER_DM_PER_SECOND`.

**Data** — no new tables. `reminder_logs` and `reminder_recipients` were designed for this in the attendance data-model change and are used as they stand. One small migration adds `CANCELLED` to the `ReminderStatus` enum. No existing row is rewritten.

**Dependencies** — adds `bullmq` and `ioredis`. Redis becomes a required service for reminders; the API, the bot, the attendance form, and the channel scheduler all keep working without it, and the status endpoint says so.

**Operational prerequisite** — the bot needs **Send Messages** on `#daily-update-reminder` for the closed-DM fallback. Without it the DMs still go out and the fallback silently reaches nobody, which is why it is reported on `GET /api/reminders/status` rather than only logged.

**Deliberately not included: the public rate limiters stay on their in-memory store.** `rateLimit.ts` names Phase 6's Redis as the moment that swap becomes possible, and it now is — but the two systems fail in opposite directions. A Redis outage that stalls reminders is an inconvenience; a Redis outage wired into the student-facing attendance form is an outage on the path ~5,000 students use to submit. That swap needs its own change, with its own decision about what the limiter does when the store is unreachable.

**Downstream** — Phase 7's dashboard gains a queue whose progress it can render. The counters were shaped for an SSE progress bar from the start; this change makes them real and leaves the streaming endpoint to the change that builds the dashboard API around it.
