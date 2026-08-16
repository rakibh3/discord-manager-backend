## 1. Infrastructure and configuration

- [x] 1.1 Add `bullmq` and `ioredis` with `bun add bullmq ioredis`.
- [x] 1.2 Add a `redis` service (`redis:7-alpine`, `restart: unless-stopped`, named volume, host port from `REDIS_PORT` defaulting to 6379) to `docker-compose.yml` alongside Postgres.
- [x] 1.3 Add `redis_url`, `reminder_worker_enabled`, and `reminder_dm_per_second` to `src/config/index.ts`. Parse the worker flag the same way `SCHEDULER_ENABLED` is parsed (unset means true, only an explicit `false`/`0` disables). Clamp the rate to `1`–`5` and fall back to `2` for a missing, non-numeric, or out-of-range value.
- [x] 1.4 Document `REDIS_URL`, `REDIS_PORT`, `REMINDER_WORKER_ENABLED`, and `REMINDER_DM_PER_SECOND` in `.env.example`, including why the rate is clamped and why the worker flag exists for operational control rather than for correctness (the limiter is Redis-backed and global, unlike `node-cron`).
- [x] 1.5 Document the bot's **Send Messages** requirement on `#daily-update-reminder` in `.env.example`, next to the existing Manage Roles note, naming the symptom: DMs go out and the fallback silently reaches nobody.

## 2. Data model

- [x] 2.1 Add `CANCELLED` to the `ReminderStatus` enum in `prisma/schema/reminder.prisma`, with a comment stating that a cancelled broadcast is a decision and a failed one is a fault, so the two must not collapse.
- [x] 2.2 Note in the same file that recipients left `PENDING` after a cancellation are correct — they were never attempted — and that `finalizeReminderLog` must not rewrite them.
- [x] 2.3 Run `bunx prisma migrate dev --name add_reminder_cancelled_status` and `bunx prisma generate`.

## 3. Repository additions

> Additions only to `src/repositories/reminder.repository.ts`. Keep the file free of `AppError`, HTTP status codes, and `req`.

- [x] 3.1 Add `countPendingRecipients(reminderId)` for the drain check.
- [x] 3.2 Change `finalizeReminderLog(reminderId)` to claim the session atomically: an `updateMany` scoped to `{ id, status: PROCESSING }` before the recompute, returning whether this caller won the claim. Only the winner may run the fallback announcement.
- [x] 3.3 Preserve the existing recompute semantics inside the claim — counts from the recipient rows, `FAILED` when any recipient is still `PENDING` — and leave a cancelled session's status alone.
- [x] 3.4 Add `cancelReminderLog(reminderId)` moving a `PENDING`/`PROCESSING` session to `CANCELLED` with `completedAt`, scoped so a terminal session is not reopened; return whether it changed anything.
- [x] 3.5 Add `findActiveReminderForDate(date)` returning a `PENDING`/`PROCESSING` session for that date, for the one-at-a-time guard.
- [x] 3.6 Add `listReminderLogs({ page, limit })` returning a paged history, newest first, with the originating administrator's id and name selected.
- [x] 3.7 Add `listRecipients(reminderId, { status?, page, limit })` returning a paged recipient list with the member's handle and display name, plus the total, served by the `(reminder_id, status)` index.
- [x] 3.8 Add `countRecipientsByStatus(reminderId)` returning the per-status breakdown for the progress read.
- [x] 3.9 Add `findRecipient(reminderId, memberId)` for the job's pre-send state check.

## 4. Queue runtime

- [x] 4.1 Create `src/lib/queue/connection.ts`: a lazily created shared `ioredis` connection from `REDIS_URL` with `maxRetriesPerRequest: null` (required by BullMQ for worker connections), an `error` listener that logs and never throws, and a `isRedisAvailable()` / `getRedisConnection()` pair.
- [x] 4.2 Document in that file why a Redis outage must not escape: the API, the bot, ingestion, and the channel scheduler have no dependency on it, and a thrown connection error would take all four down for a feature none of them use.
- [x] 4.3 Create `src/lib/queue/reminder.queue.ts` with the queue name constant, the `TReminderJobData` type (`{ reminderId, memberId, discordUserId }` — identity only, never the message text), and default job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 86400 }`.
- [x] 4.4 Implement `enqueueReminderJobs(reminderId, targets)` using `addBulk` in chunks, with `jobId` set to `` `${reminderId}:${memberId}` `` so a duplicate enqueue is deduplicated by Redis.
- [x] 4.5 Implement `removeReminderJobs(reminderId)` as a best-effort removal of that broadcast's waiting and delayed jobs, documented as an optimization — the session status check in the worker is the actual cancel mechanism.
- [x] 4.6 Implement `getQueueDepth()` returning waiting/active/failed counts for the status endpoint, returning `null` rather than throwing when Redis is unreachable.
- [x] 4.7 Comment the payload decision in place: the message is read from the session row so the delivered text and the audited text cannot diverge.

## 5. Discord DM transport

- [x] 5.1 Create `src/lib/discord/dm.ts` as the only module that sends a DM or writes to the reminder channel.
- [x] 5.2 Implement `sendMemberDm(discordUserId, content)` returning a discriminated result — `delivered`, `dm_closed`, `failed` (with reason), or `retryable` (with an optional `retryAfterMs`) — and never throwing.
- [x] 5.3 Map Discord error codes explicitly: `50007` → `dm_closed`, `10013` (Unknown User) → `failed`, missing-access/forbidden → `failed`, `429` → `retryable` carrying the retry-after, network/5xx/timeout → `retryable`. Comment the table as the single place to change when Discord adds a code.
- [x] 5.4 Implement `announceClosedDms(members)` posting to `REMINDER_CHANNEL_ID` resolved through `getDiscordClient()` — never by channel name — verifying it is a text channel in the configured guild.
- [x] 5.5 Chunk the mentions by a conservative count so every message stays under Discord's 2,000-character limit, with a short header on each message.
- [x] 5.6 Set `allowedMentions: { parse: [], users: <ids in this chunk> }` on every fallback message. Comment that `parse: []` is what makes an `@everyone` structurally impossible from this path regardless of surrounding text.
- [x] 5.7 Detect and report the missing-permission failure (`DiscordAPIError` `50013`) naming Send Messages and the reminder channel ID, returning a structured result rather than throwing.
- [x] 5.8 Build the DM body as the fixed `⚠️ **Daily Update Reminder**` heading followed by the session's message text.

## 6. Queue worker

- [x] 6.1 Create `src/lib/queue/reminder.worker.ts` holding the `Worker`, its in-memory runtime state, and no `AppError` or HTTP status codes.
- [x] 6.2 Construct the worker with `limiter: { max: config.reminder_dm_per_second, duration: 1000 }` and a small concurrency, and comment that the limiter's counter is in Redis and therefore shared across workers.
- [x] 6.3 Implement the processor in order: load the session row; return without sending if it is `CANCELLED` or otherwise terminal; load the recipient row and return if it is no longer `PENDING`; then send.
- [x] 6.4 On the first job of a session, move the session to `PROCESSING` via `markReminderProcessing` — idempotently, so it is safe on every job.
- [x] 6.5 Record the outcome through `markRecipientOutcome` and bump the cached counters through `incrementCounts` for `delivered` / `dm_closed` / `failed`, then return normally — a closed DM is a recorded outcome, not a job failure.
- [x] 6.6 On a `retryable` result, throw so BullMQ retries with backoff, leaving the recipient `PENDING`.
- [x] 6.7 On a `429`, call `worker.rateLimit(retryAfterMs)` and throw `Worker.RateLimitError()` so the job returns to `wait` without consuming a retry attempt, and comment why that differs from an ordinary throw.
- [x] 6.8 Add a `failed` event handler that writes the `FAILED` outcome and the error detail once attempts are exhausted, so a job that dies for a reason the processor never saw cannot leave a recipient stuck in `PENDING`.
- [x] 6.9 Implement the drain check after each recorded outcome: `countPendingRecipients(reminderId)`; at zero, call the claiming `finalizeReminderLog` and only on a won claim list the `DM_CLOSED` recipients and call `announceClosedDms`.
- [x] 6.10 Record the fallback announcement's outcome (`ranAt`, `reminderId`, `ok`, `error`, `mentioned`) in the module's runtime state, in the style of `getSyncState()` / `getSchedulerState()`.
- [x] 6.11 Implement `startReminderWorker()`: no-op with a log line when the worker is disabled or Redis is unreachable; otherwise construct the worker and register its `error`/`failed` handlers.
- [x] 6.12 Implement `stopReminderWorker()` calling `worker.close()` so an in-flight send finishes, safe to call when the worker never started.
- [x] 6.13 Implement `getReminderQueueState()` returning `{ workerRunning, redisConnected, redisError, queueDepth, lastFallback }`.
- [x] 6.14 Wrap every handler so nothing escapes to the process; a job that throws unexpectedly is contained by BullMQ's failure handling and logged.

## 7. Reminder module (HTTP)

- [x] 7.1 Create `src/modules/reminder/reminder.validation.ts`: `date` as the existing `dhakaDateSchema`, required, and refused when later than the current Dhaka date; `message` trimmed, non-empty, and capped so the heading plus the text stays inside Discord's message limit; query schemas for pagination and the recipient status filter.
- [x] 7.2 Create `src/modules/reminder/reminder.service.ts` owning the business rules and every `AppError`; it must not touch Prisma directly or BullMQ's internals beyond the queue module's exports.
- [x] 7.3 Implement `previewTargets(date)` returning the count and the target list from `dailyStatusRepository.listMembersMissingUpdate(date)`.
- [x] 7.4 Implement `startBroadcast({ date, message }, adminId)` in order: check Redis readiness and throw `AppError(503, …)` naming Redis if unavailable; refuse with `AppError(409, …)` when `findActiveReminderForDate(date)` returns a session; resolve targets and throw `AppError(400, …)` when the list is empty; create the log; `addRecipients`; enqueue; return the id and target count for a `202`.
- [x] 7.5 Implement `getBroadcast(id)` composing the session row with the per-status breakdown and the outstanding count, using `findUniqueOrThrow` so a missing id becomes the central P2025 404.
- [x] 7.6 Implement `listBroadcasts(query)` and `listBroadcastRecipients(id, query)` over the new repository reads.
- [x] 7.7 Implement `cancelBroadcast(id)`: `cancelReminderLog` first, `AppError(409, …)` when it changed nothing because the session was already terminal, then best-effort `removeReminderJobs` whose failure is logged rather than surfaced as a failed cancel.
- [x] 7.8 Implement `getQueueStatus()` returning `getReminderQueueState()` plus the configured DM rate.
- [x] 7.9 Create `src/modules/reminder/reminder.controller.ts` with `catchAsync`-wrapped handlers returning through `sendResponse`, reading `req.user` for the originating administrator, and answering `202` from the send handler.
- [x] 7.10 Create `src/modules/reminder/reminder.routes.ts`: `GET /targets`, `POST /send`, `GET /`, `GET /status`, `GET /:id`, `GET /:id/recipients`, `POST /:id/cancel` — every route behind `auth(UserRole.ADMIN)`, with `/targets` and `/status` declared before `/:id` so they are not captured by the parameter route.
- [x] 7.11 Register `reminderRouter` at `/api/reminders` in `src/app.ts`, above `notFoundRoute`.

## 8. Process lifecycle

- [x] 8.1 Start the worker in `src/server.ts` from the same `onDiscordReady()` hook the scheduler uses, without awaiting anything that could delay readiness, with its own `.catch`.
- [x] 8.2 Call `stopReminderWorker()` in `shutdown()` before `stopDiscordBot()`, so no delivery is sent into a closing gateway connection.
- [x] 8.3 Close the shared Redis connection during shutdown, after the worker.
- [x] 8.4 Confirm the worker is not started when the bot never connects, and that `GET /api/reminders/status` reports that honestly.

## 9. Documentation

- [x] 9.1 Document the reminder queue in `CLAUDE.md`: the queue/worker split, why one job is one recipient, the rate limiter and where its counter lives, and that `dm.ts` is the only module that sends a DM or writes to the reminder channel.
- [x] 9.2 Document the error-code table (`50007` is an outcome, not a failure), the at-least-once window and the pre-send status check that narrows it, and the drain latch that keeps the fallback announcement single.
- [x] 9.3 Document that `date` is required on `POST /send` and never inferred, and that a broadcast is refused while one for the same date is running.
- [x] 9.4 Document the Redis containment rule next to the existing notes on process-local rate-limit counters and `SCHEDULER_ENABLED`, including why the public rate limiters were deliberately **not** moved onto Redis in this change.
- [x] 9.5 Add the seven `/api/reminders` requests to `postman-collection.json`.
- [x] 9.6 Tick the Phase 6 boxes in `PRD.md`'s roadmap and note that the SSE progress stream stays with Phase 7.

## 10. Verification

> Anything that sends a real DM or posts to `#daily-update-reminder` must be run against the live
> server by a human, and against a deliberately small target set first. Note on each line what was
> actually run.
>
> Everything verifiable without delivering a DM was run. Those runs used the API with
> `DISCORD_BOT_TOKEN` unset, so the bot never connected and no DM was possible — deliberately, since
> the live target list for this server is **2,189 members** and the boot reconcile would also have
> edited the real `#daily-update` channel. The queue, worker, retry/backoff, drain, finalize claim
> and cancel paths were exercised in that mode (every send resolves to `retryable`, which is what
> drives the retry and terminal-failure paths). All test broadcasts, synthetic rows, and queue keys
> were deleted afterwards; `reminder_logs`, `reminder_recipients` and the queue are all back to 0.

- [x] 10.1 `bun run lint` and `bun run build` pass. _(Verified: both clean.)_
- [x] 10.2 With Redis stopped: the API starts, the bot connects, ingestion and the channel scheduler work, `GET /api/reminders/status` reports Redis unreachable, and `POST /send` returns `503` naming Redis without creating a session or recipient rows. _(Verified with the container stopped: status reported `redisConnected: false` with `connect ECONNREFUSED`, `POST /send` returned 503 naming Redis, `reminder_logs`/`reminder_recipients` both stayed 0, and `/api/attendance/verify-user` + `/api/users/me` kept answering 200. Restarting Redis reconnected the running process with no restart. Bot/ingestion/scheduler half was run with the bot token unset — see the note above 10.7.)_
- [x] 10.3 `GET /api/reminders/targets?date=` matches `MISSING_UPDATE` + `MISSING_BOTH` from the dashboard aggregation for the same date, and excludes departed members. _(Verified: 2189 targets == `missingUpdateOnly + missingBoth` == 2189 for the same date, and the 1 departed member in the directory was not targeted.)_
- [x] 10.4 Reject cases return distinguishable errors: missing `date`, malformed `date`, a future `date`, an empty `message`, an over-long `message`, and an empty target list. _(All six verified, each returning one message: missing/malformed/future `date`, empty and over-long `message`, and an empty target list — the last by giving every member an update for a date, confirming the 400, then deleting the synthetic rows.)_
- [x] 10.5 `POST /send` returns `202` with the reminder id and target count, and every target has a `PENDING` recipient row before the first DM leaves. _(Verified: 202 with `queuedJobs == targetCount == 2189`, and all 2189 recipient rows `PENDING` with the queue holding 2189 waiting jobs.)_
- [x] 10.6 A second `POST /send` for the same date while the first is running returns `409`; one for a different date is accepted. _(409 verified with its message naming the running broadcast; a different date resolves its own target list. Both test broadcasts were cancelled and deleted afterwards.)_
- [ ] 10.7 On a small target set: DMs arrive paced at the configured rate, `GET /:id` progress advances, and the session reaches `COMPLETED` with counts recomputed from the recipient rows.
- [ ] 10.8 A member with DMs disabled is recorded `DM_CLOSED`, is not retried, and is mentioned in `#daily-update-reminder` once the broadcast drains.
- [ ] 10.9 The fallback message pings only the members it names — verify `allowedMentions` by including an `@everyone` in surrounding text in a scratch build and confirming nobody beyond the named members is notified.
- [ ] 10.10 More closed-DM recipients than fit in one message are split across several, each under the limit.
- [ ] 10.11 Remove the bot's Send Messages permission on `#daily-update-reminder`, run a broadcast with a closed-DM recipient, and confirm the DMs still deliver and the failure appears on `GET /api/reminders/status` naming the permission. Restore it afterwards.
- [ ] 10.12 Kill the process mid-broadcast and restart: queued jobs resume, already-recorded recipients are not re-DMed, and the session finishes. _(Resume half verified indirectly: jobs persist in Redis across a worker stop/start and the pre-send recipient check drops anything already recorded. "Not re-DMed" needs real deliveries — human.)_
- [x] 10.13 `POST /:id/cancel` on a running broadcast stops further DMs, records `CANCELLED`, leaves delivered recipients delivered and unattempted ones `PENDING`; cancelling a finished broadcast returns `409`. _(Verified end to end: cancel returned `CANCELLED` with 2189 recipients still `PENDING` (never attempted, not failed), `removeReminderJobs` cleared exactly that broadcast's 2189 queued jobs and left an unrelated job untouched, and a second cancel returned 409. The "stops further DMs" half is structural — the worker's pre-send session check — and is covered live by 10.7.)_
- [ ] 10.14 The fallback announcement fires exactly once when the last two jobs complete concurrently — force it by raising the worker's concurrency temporarily. _(Claim latch verified: two jobs finished 2ms apart at concurrency 2 and the finalize claim was won once — one "Broadcast finished" log, one close-out. The announcement half needs a real `DM_CLOSED` recipient — human.)_
- [x] 10.15 Every `/api/reminders` route returns `401` without an admin token, including `GET /targets` and `GET /status`. _(Verified: all seven routes return 401, including `/targets` and `/status`.)_
- [ ] 10.16 No `daily_updates` row is created for the fallback announcement (it is the bot's own message, in a different channel).
