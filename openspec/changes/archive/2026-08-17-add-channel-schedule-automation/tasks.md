## 1. Dependency and configuration

- [x] 1.1 Add `node-cron` (v4) to dependencies with `bun add node-cron` and `@types/node-cron` to devDependencies if the package does not ship its own types.
- [x] 1.2 Add `SCHEDULER_ENABLED` to `src/config/index.ts`, parsed so an unset or empty value means `true` and only an explicit `false` disables the timed jobs.
- [x] 1.3 Document `SCHEDULER_ENABLED` in `.env.example`: what it does, why exactly one instance may run the jobs, and that the manual endpoints work on every instance regardless.
- [x] 1.4 Document the bot's **Manage Roles** requirement on `#daily-update` in `.env.example`, alongside the existing privileged-intent prerequisites.

## 2. Dhaka wall-clock helper

- [x] 2.1 Add `getDhakaTimeOfDay(instant?)` to `src/utils/dhakaDate.ts`, returning `HH:mm` via a module-level `Intl.DateTimeFormat` with `timeZone: DHAKA_TIMEZONE`, `hour12: false`, and 2-digit hour and minute.
- [x] 2.2 Add `getDhakaWeekday(instant?)` returning `0`–`6` with `0` = Sunday, derived through the same timezone-explicit formatting rather than from `Date.getDay()`.
- [x] 2.3 Add a shared `HH:mm` shape guard and Zod schema (`isValidTimeOfDay` / `timeOfDaySchema`) next to the existing `isValidDhakaDate` / `dhakaDateSchema`, so the validation layer and the scheduler share one definition.
- [x] 2.4 Document in place that these exist for the scheduler's "is now inside the window" decision and are `TZ`-independent for the same reason `getDhakaDate` is.

## 3. Data model

- [x] 3.1 Create `prisma/schema/schedule.prisma` with a `ChannelSchedule` model: `id`, `key` (`@unique`, value `DAILY_UPDATE`), `openTime`, `closeTime` (`String`, `HH:mm`), `daysOfWeek` (`Int[]`), `enabled` (`Boolean @default(true)`), `updatedById` (`String?`), `createdAt`, `updatedAt`, mapped to `channel_schedules` with snake_case columns.
- [x] 3.2 Add the `updatedBy` relation to `User` in `prisma/schema/auth.prisma` with `onDelete: SetNull`, so deleting an admin account cannot delete the schedule.
- [x] 3.3 Comment the model with why times are `String` `HH:mm` rather than `DateTime` (same reasoning as the civil-date columns) and why there is no timezone column.
- [x] 3.4 Run `bunx prisma migrate dev --name add_channel_schedule` and `bunx prisma generate`.

## 4. Repository layer

- [x] 4.1 Create `src/repositories/channelSchedule.repository.ts` exporting `channelScheduleRepository`.
- [x] 4.2 Implement `getOrCreateSchedule()` returning the `DAILY_UPDATE` row, creating it with `18:00` / `23:59` / all seven days / enabled when absent. Use an upsert so two concurrent first reads cannot create two rows.
- [x] 4.3 Implement `updateSchedule(data)` accepting the partial fields plus `updatedById`, returning the updated row with the updating admin's id and name selected for the read payload.
- [x] 4.4 Keep the file free of `AppError`, HTTP status codes, and `req` — it returns data or `null`, per the repository rule.

## 5. Channel state operations

- [x] 5.1 Create `src/lib/discord/channel.state.ts` as the only module that edits the daily-update channel's permission overwrite.
- [x] 5.2 Implement a channel resolver that fetches `DAILY_UPDATE_CHANNEL_ID` through `getDiscordClient()`, verifies it is a text channel in the configured guild, and returns `null` with a logged error otherwise.
- [x] 5.3 Implement `setDailyUpdateChannelOpen(open, { announce })`: edit the `@everyone` overwrite for `SendMessages` only — never touch `ViewChannel` on lock — then post the embed when `announce` is true.
- [x] 5.4 Build the green "🟢 Daily Update Channel is OPEN" and red "🔴 Daily Update Channel is CLOSED" embeds, each naming the configured close and next open times taken from the live schedule rather than hard-coded strings.
- [x] 5.5 Send the announcement in its own try/catch: a failed embed must leave a successful permission change in place.
- [x] 5.6 Implement `isDailyUpdateChannelOpen()` reading the live `@everyone` overwrite, returning `true` / `false` / `null` where `null` means the channel could not be read.
- [x] 5.7 Detect the missing-permission failure (`DiscordAPIError` code `50013`) and log it naming Manage Roles and the channel ID; return a structured result so the caller can report it.

## 6. Scheduler

- [x] 6.1 Create `src/lib/scheduler/channelSchedule.scheduler.ts` holding the `node-cron` tasks, the module-level last-run state, and no Prisma calls of its own beyond the repository.
- [x] 6.2 Implement cron-expression construction from the stored schedule: `<mm> <HH> * * <days>` for open and for lock, built from `HH:mm` and the weekday list.
- [x] 6.3 Implement `startChannelScheduler()`: no-op with a log line when `SCHEDULER_ENABLED` is false; otherwise load the schedule, register both tasks with `{ timezone: DHAKA_TIMEZONE }`, and run the boot reconcile.
- [x] 6.4 Implement `reloadChannelSchedule()`: `destroy()` the existing tasks (never `stop()`, which retains the old expression), re-register from the stored values, then reconcile.
- [x] 6.5 Register no tasks at all when the schedule is disabled, and skip the reconcile in that case so a disabled schedule never touches the channel.
- [x] 6.6 Implement `reconcileChannelState()`: compute the expected state from `getDhakaTimeOfDay()` / `getDhakaWeekday()` against the window, compare with `isDailyUpdateChannelOpen()`, and correct only on disagreement — always with `announce: false`.
- [x] 6.7 Log every reconcile correction at info level with the expected state, the observed state, and the reason.
- [x] 6.8 Track `lastRun` in memory (`action`, `ranAt`, `ok`, `error`) written by the scheduled jobs, the reconcile, and the manual actions; expose it through a getter in the style of `getSyncState()` / `getIngestionState()`.
- [x] 6.9 Expose `getSchedulerState()` returning `{ enabled, running, nextOpenAt, nextLockAt, lastRun }`, taking the next run times from `task.getNextRun()`.
- [x] 6.10 Implement `stopChannelScheduler()` destroying both tasks, safe to call when the scheduler never started.
- [x] 6.11 Wrap every cron callback and the reconcile so nothing escapes to the process; record the failure in `lastRun` and leave the tasks registered.
- [x] 6.12 Guard the jobs against acting while the bot is disconnected: log and record it rather than issuing a doomed Discord call.

## 7. Schedule module (HTTP)

- [x] 7.1 Create `src/modules/schedule/schedule.validation.ts` with the update schema: optional `openTime`, `closeTime` (both `timeOfDaySchema`), `daysOfWeek` (non-empty array of unique integers `0`–`6`), and `enabled`.
- [x] 7.2 Validate the *resulting* schedule, not just the submitted fields — merge the partial update over the stored row before checking that `closeTime` is strictly later than `openTime`, so a lone `closeTime` change cannot create a cross-midnight window.
- [x] 7.3 Reject an empty update body, and ignore any submitted `timezone` field rather than storing it.
- [x] 7.4 Create `src/modules/schedule/schedule.service.ts` with `getSchedule()`, `updateSchedule(payload, adminId)`, `openChannelNow()`, and `lockChannelNow()`; business rules and `AppError` live here, Prisma does not.
- [x] 7.5 Have `getSchedule()` compose the stored row, the fixed `timezone: 'Asia/Dhaka'`, the scheduler state from `getSchedulerState()`, and the live channel state from `isDailyUpdateChannelOpen()`.
- [x] 7.6 Have `updateSchedule()` persist through the repository, then trigger `reloadChannelSchedule()` without letting a reload failure fail the save — log it and let the status report it.
- [x] 7.7 Throw `AppError(503, …)` from the manual actions when the bot is not connected or the channel cannot be resolved, matching the wording style of `triggerMemberSync`.
- [x] 7.8 Create `src/modules/schedule/schedule.controller.ts` with `catchAsync`-wrapped handlers returning through `sendResponse`, reading `req.user` for the audit id.
- [x] 7.9 Create `src/modules/schedule/schedule.routes.ts`: `GET /daily-update`, `PATCH /daily-update` (with `validateRequest`), `POST /daily-update/open`, `POST /daily-update/lock` — every route behind `auth(UserRole.ADMIN)`.
- [x] 7.10 Register `scheduleRouter` at `/api/schedule` in `src/app.ts`, above `notFoundRoute`.

## 8. Process lifecycle

- [x] 8.1 Start the scheduler in `src/server.ts` after `startDiscordBot()` resolves successfully, without awaiting anything that could delay readiness, and with its own `.catch` so a failure cannot reject startup.
- [x] 8.2 Call `stopChannelScheduler()` in `shutdown()` before the Discord client is destroyed, so no job fires mid-shutdown.
- [x] 8.3 Confirm the scheduler is not started when the bot never connects, and that `getSchedulerState()` reports that honestly rather than showing next run times that cannot fire.

## 9. Documentation

- [x] 9.1 Document the scheduler in `CLAUDE.md`: the stored-schedule model, why times are `HH:mm` in a fixed `Asia/Dhaka`, why the window may not cross midnight, and that `channel.state.ts` is the only writer of channel permissions.
- [x] 9.2 Document the boot reconcile and the deliberate absence of an announcement on it, and the `SCHEDULER_ENABLED` single-process constraint next to the existing note about process-local rate-limit counters.
- [x] 9.3 Add the four `/api/schedule` requests to `postman-collection.json`.
- [x] 9.4 Tick the Phase 5 boxes in `PRD.md`'s roadmap and note that the times are admin-managed rather than hard-coded.

## 10. Verification

> 10.3-10.6, 10.9 (channel half), 10.10 and 10.13 (channel half) change permissions on and post embeds
> into the real `#daily-update` channel, so they are left for a human to run against the live server.
> Everything verifiable without touching Discord was run; see the notes on each line.

- [x] 10.1 `bun run lint` and `bun run build` pass.
- [x] 10.2 `GET /api/schedule/daily-update` on a fresh database returns the created defaults (`18:00` / `23:59` / all days / enabled), a `nextOpenAt` in the future, and the live channel state.
- [ ] 10.3 `PATCH` the open time to two minutes ahead: the channel opens on time, the green embed appears, and `daily_updates` gains no row for that embed.
- [ ] 10.4 `PATCH` the close time to two minutes ahead: the channel locks, the red embed appears, and members can still read the channel.
- [ ] 10.5 A student message posted while locked is refused by Discord; one posted seconds before the lock is still ingested with the correct `message_date`.
- [ ] 10.6 Restart the process mid-window with the channel manually locked: it reopens on boot with **no** embed. Restart outside the window with the channel manually open: it locks with no embed.
- [x] 10.7 Reject cases return 400 with distinguishable messages: `closeTime` before `openTime`, equal times, empty `daysOfWeek`, a day outside `0`–`6`, and a malformed `HH:mm`.
- [x] 10.8 A `PATCH` sending only `closeTime: "02:00"` against a stored `openTime: "18:00"` is rejected as cross-midnight.
- [ ] 10.9 `POST /daily-update/open` and `/lock` change the channel immediately and leave the stored schedule untouched; both are rejected without an admin token. _(Auth half verified: 401 without a token, 503 with no bot connected. The channel half needs a live bot.)_
- [ ] 10.10 Remove the bot's Manage Roles permission on the channel and trigger a manual open: the failure names the missing permission and appears in `GET /api/schedule/daily-update` as the last run's error. Restore the permission afterwards.
- [x] 10.11 Run the process with `TZ=UTC` and confirm the jobs fire at the Dhaka wall-clock times and `getDhakaWeekday()` reports the Dhaka day.
- [x] 10.12 Set `SCHEDULER_ENABLED=false`, restart, and confirm no jobs are registered, no reconcile runs, the status reports the scheduler as not running, and the manual endpoints still work.
- [ ] 10.13 Disable the schedule while the channel is open and confirm it stays open, with the status showing `enabled: false` alongside the live open state. _(Payload half verified: disabling destroys the jobs, keeps the times, and skips the reconcile. The live channel half needs a live bot.)_
