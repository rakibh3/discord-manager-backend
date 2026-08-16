## Context

The window that the whole daily-update flow assumes exists does not exist yet. Ingestion (Phase 4) stores whatever arrives whenever it arrives, and its design says so explicitly: it refuses to time-check a message because "the channel lock is the enforcement mechanism, and a time check here would double-implement the window in a second place that could disagree with the scheduler." That scheduler is this change. Until it lands, `#daily-update` is permanently open and a 3:00 AM post counts for a day that already closed.

The constraints this design works inside:

- **One process, three subsystems.** Express, the Discord gateway client, and now the scheduler share a process. `src/lib/discord/client.ts` is documented as never throwing — a Discord problem must not stop the REST API. The scheduler inherits the same contract in both directions: it must not take down the API or the gateway, and neither may take it down.
- **Not HTTP-scoped.** A cron callback has no `req` to fail and no `AppError` to throw, exactly like the gateway handlers. Data access therefore belongs in `src/repositories/`, which is where the attendance domain's queries already live for this same reason.
- **Golden Rule 5** — every time calculation is `Asia/Dhaka`, derived from `src/utils/dhakaDate.ts` and never from the server's `TZ`.
- **The PID's own numbers conflict.** §7 and §14 say the channel locks at 11:59 PM; §1 and §14's header say midnight. The resolution is that the *submission window* ends at 11:59 PM (the default `closeTime`) and the *civil day* ends at midnight — and because the time is now configurable, the disagreement stops being something the code has to pick a winner for.
- **`Manage Roles` on the channel** is required for the bot to edit a permission overwrite. It is not currently a documented prerequisite anywhere, and its absence produces a channel that never opens with nothing but a log line to show for it.

## Goals / Non-Goals

**Goals:**

- `#daily-update` opens and locks on a schedule expressed in Dhaka wall-clock time, announced in the channel.
- The times, the active weekdays, and an on/off switch are editable by an admin from the dashboard and take effect immediately, with no restart and no deploy.
- An admin cannot save a schedule that would silently never fire, or one whose window disagrees with the civil day the attendance domain files by.
- A process restart mid-window leaves the channel in the state the schedule says it should be in.
- A scheduler that is failing — wrong bot permission, unreachable channel — is visible on the dashboard, not only in the logs.
- An admin can force the channel open or locked immediately, without touching the schedule.

**Non-Goals:**

- The post-midnight reminder run and its BullMQ queue (Phase 6). That needs Redis; channel automation does not, and coupling them would block this on infrastructure it has no use for.
- A persisted run-history table. The last run's outcome is kept in memory and reported; a durable audit of every open and lock is not being asked for and would be a table written twice a day forever.
- Admin-editable announcement copy. The embeds ship with fixed text.
- Scheduling any channel other than `#daily-update`. The stored row is keyed so a second one is possible later, but nothing else is scheduled today.
- Enforcing the window a second time inside ingestion. The permission overwrite is the enforcement; see the ingestion design's non-goals.

## Decisions

### 1. Store `HH:mm` + weekdays, not a cron expression

The stored shape is `openTime` / `closeTime` as `HH:mm` strings, `daysOfWeek` as an integer array (`0`=Sunday … `6`=Saturday), and `enabled`. The cron expression is built from those at registration time (`m H * * d,d,d`) and never stored.

A cron string is a programmer's interface. An admin who types `0 6 * * *` intending 6:00 PM gets a channel that opens at dawn, and there is no error anywhere — the job fires happily at the wrong time. `HH:mm` has one meaning, validates against one regex, renders back into a time picker without ambiguity, and cannot express a schedule the dashboard is unable to display.

*Alternative rejected:* storing the cron expression with a time-picker UI on top. Round-tripping cron back into a picker is lossy the moment anyone uses a step or a range, so the UI would have to fall back to a raw text field — which is the first option with extra steps.

### 2. The timezone is a constant, not a column

`Asia/Dhaka` comes from `DHAKA_TIMEZONE` in `src/utils/dhakaDate.ts` and is returned in the API payload as a read-only field. It is not stored and not editable.

A timezone column would be a foot-gun with no upside: `attendance_date` and `message_date` are Dhaka civil dates by definition across the entire schema, so a schedule running in `Asia/Kolkata` would open the channel 30 minutes off the day boundary that every record is filed under, and a schedule in `America/New_York` would open it on the wrong calendar day entirely. Golden Rule 5 says one timezone; this keeps it to one.

### 3. The window may not cross Dhaka midnight

Validation requires `closeTime` to be strictly later than `openTime`, so the whole window sits inside one Dhaka calendar day. `18:00`–`23:59` is fine; `22:00`–`02:00` is a 400.

This is not arbitrary conservatism. A message posted at 00:30 inside a cross-midnight window gets `message_date` for the *following* day (correctly — `getDhakaDate(message.createdAt)`), so the student appears to have submitted for tomorrow and missing for today. The dashboard's completion rate for the day would be wrong in a way that looks like a data bug rather than a configuration choice. Refusing the configuration is far cheaper than making the aggregation understand windows.

### 4. `node-cron`, not BullMQ repeatable jobs

The PID offers both. BullMQ needs Redis, which the project does not run yet and does not need until the reminder queue. `node-cron` v4 is zero-dependency, takes a `timezone` option per task, and exposes `stop()` / `destroy()` / `getNextRun()` — which is exactly the reload story this change needs, and `getNextRun()` gives the dashboard's "next open at" for free rather than requiring a second cron parser.

The trade-off is real: `node-cron` is in-process, so the schedule lives and dies with the process and does not coordinate across replicas. That is handled by decision 8, not by pretending it is not a limitation.

*Alternative rejected:* `setTimeout` chains computed from the Dhaka clock. Hand-rolled, and every DST or leap-second edge case becomes ours. Bangladesh observes no DST today, but the IANA-zone reasoning in `dhakaDate.ts` exists precisely because that could change.

### 5. Channel state is written in exactly one place

`src/lib/discord/channel.state.ts` owns `openDailyUpdateChannel()` and `lockDailyUpdateChannel()`: fetch the channel by `DAILY_UPDATE_CHANNEL_ID`, edit the `@everyone` overwrite, send the embed. The scheduled jobs, the boot reconcile, and the manual override endpoints all call these — three triggers, one implementation. A second path that edits permissions differently is how "the channel is open but nobody can post" happens.

The announcement is a parameter, not a separate function: the reconcile passes `announce: false` (see decision 7), everything else passes `true`.

### 6. Reads of channel state come from Discord, not from a column

"Is the channel open right now" is answered by reading the live `@everyone` overwrite for `SendMessages`, never by a stored flag. Discord is the source of truth — an admin can flip the permission by hand in the client at any time, and a cached column would then be confidently wrong on the dashboard. This also removes any need for a state-tracking table.

### 7. Boot reconcile applies permissions silently

At startup (and after any schedule save) the scheduler computes whether *now* falls inside the window for today's weekday, compares that against the live overwrite, and corrects it if they disagree — with no embed.

Suppressing the announcement is deliberate: a container that restarts five times during a deploy would otherwise post "🟢 Channel is OPEN" five times into a channel 5,000 students are reading. The embed marks a *transition* that students should notice; a reconcile is bookkeeping. The correction is logged at info level either way.

*Alternative rejected:* announcing on reconcile when the state actually changed. Better than always announcing, but a crash-loop that alternates states would still spam, and the failure mode is public.

### 8. One scheduler process, gated by `SCHEDULER_ENABLED`

`node-cron` tasks are per-process. With N replicas, every job fires N times: N permission edits (idempotent, harmless) and N announcement embeds (visible, embarrassing). `SCHEDULER_ENABLED` defaults to `true` and is set to `false` on every replica but one.

This is the same class of constraint the codebase already documents for `express-rate-limit`'s in-memory store — process-local state in a horizontally scaled API — and it is handled the same way: named, documented in `.env.example`, and left as a single point to change when Phase 6 brings Redis and BullMQ repeatable jobs become available as a genuinely distributed alternative.

The flag gates only the *timed* jobs. The manual override endpoints and the read endpoint work on every replica, because they act through the shared Discord client, not through cron.

### 9. A saved schedule reloads by destroy-and-re-register

The update service writes the row, then calls `reloadChannelSchedule()`, which destroys the existing tasks and registers new ones from the saved values, then runs the reconcile. Destroy rather than stop: a stopped task retains its old expression, and a stale task that gets restarted later is the kind of bug that only appears weeks after the change.

Reload is fire-and-forget relative to the response — the row is saved either way, and a reload failure is logged and surfaced through the read endpoint rather than failing a write that already succeeded.

### 10. The schedule row is a singleton created on first read

`channel_schedules` holds one row, identified by a unique `key` column with the value `DAILY_UPDATE`. `getOrCreateSchedule()` creates it with the PID's defaults (18:00, 23:59, all seven days, enabled) on first access, so there is no seed step to forget and no migration that has to invent data.

The `key` column rather than a hard-coded singleton id leaves room for `#attendance` or another channel later without a table rename, at the cost of one indexed string column.

### 11. Routes live in a new `/api/schedule` module

A new `src/modules/schedule/` following the four-file pattern, mounted in `src/app.ts`, all routes behind `auth(UserRole.ADMIN)`:

- `GET /api/schedule/daily-update` — stored config, `nextOpenAt` / `nextLockAt` from `getNextRun()`, live channel state, last run outcome, scheduler enabled/running.
- `PATCH /api/schedule/daily-update` — partial update of `openTime`, `closeTime`, `daysOfWeek`, `enabled`.
- `POST /api/schedule/daily-update/open` and `/lock` — manual override, announcing normally.

The proposal's sketch put the manual actions under `/api/discord/channel/*`. They are here instead so that one module owns channel state end to end; splitting "open the channel on a timer" from "open the channel now" across two modules would put two callers of the same helper in two places for no gain. `/api/discord` stays what it is: bot connection and member-sync status.

### 12. Nothing in the scheduler throws past its own boundary

Every cron callback and the reconcile are fully wrapped. A Discord outage at 6:00 PM logs an error, records it as the last-run outcome, and leaves the next day's job registered. The service layer that backs the HTTP endpoints keeps throwing `AppError` as usual — that is the one context where there is a request to fail.

Failure is not silent: the last-run outcome (`ranAt`, `action`, `ok`, `error`) is in-memory state reported by the read endpoint, in the same spirit as `getIngestionState()` and `getSyncState()`. A missing `Manage Roles` permission is a `DiscordAPIError[50013] Missing Permissions`, and that string reaching the dashboard is what turns "the channel never opened and nobody knows why" into a two-minute fix.

## Risks / Trade-offs

- **Two replicas both run cron** → Duplicate announcement embeds in a channel students read. Mitigated by `SCHEDULER_ENABLED` and documented in `.env.example`; the permission edit itself is idempotent, so the damage is cosmetic. Revisit when Redis lands in Phase 6.

- **The bot lacks `Manage Roles` on the channel** → Every open and lock fails and the window is never enforced. Mitigated by reporting the error on `GET /api/schedule/daily-update` rather than only logging it, and by naming the permission in `.env.example` next to the intents prerequisite it resembles. Not preventable at startup: the check is per-channel and the bot may be re-permissioned at any time.

- **The process is down at 6:00 PM** → The open never fires and the channel stays locked. Mitigated by the boot reconcile, which corrects the state as soon as the process returns. The announcement for that transition is lost; the students who matter see an open channel.

- **An admin disables the schedule while the channel is open** → It stays open indefinitely, because disabling stops future jobs rather than forcing a state. That is the correct reading of "disabled" (the scheduler is off, not "the channel is locked"), but it is surprising enough to warrant the manual lock endpoint being the documented way to close it, and the read endpoint showing live channel state next to the disabled flag.

- **An admin sets `openTime` to a moment that has already passed today** → Nothing fires today; the reconcile at save time opens the channel immediately if now is inside the new window. That is almost always what was meant, but it means saving a schedule can change the channel's state right now, which the dashboard should say plainly.

- **`daysOfWeek` excludes today, mid-window** → The reconcile locks the channel on save. Correct, and worth stating: editing weekdays is not a passive change.

- **The permission overwrite is the only enforcement** → Anyone with a role that overrides `@everyone` (moderators, admins) can still post outside the window, and their message will be ingested. Accepted: they are not the population being measured, and adding a time check in ingestion is explicitly rejected by that design.

## Migration Plan

1. **Discord first:** grant the bot **Manage Roles** on `#daily-update` (or a role that carries it). Without this the schedule saves fine and never takes effect.
2. `bunx prisma migrate dev --name add_channel_schedule` then `bunx prisma generate`. One new table; no existing table's data is touched.
3. Set `SCHEDULER_ENABLED=true` on exactly one instance, `false` on the rest. Unset defaults to `true`, which is correct for the current single-instance deployment.
4. Deploy. On first boot the default row is created (18:00 / 23:59 / all days / enabled) and the reconcile sets the channel to match the current time — expect a permission change on the channel immediately, with no announcement.
5. Verify: `GET /api/schedule/daily-update` reports the defaults, a `nextOpenAt` in the future, live channel state, and no last-run error.
6. Verify a transition without waiting for 6:00 PM: `PATCH` `openTime` to two minutes from now, confirm the embed and the permission change, then restore.
7. **Rollback:** revert the deploy. The channel keeps whichever permission state it was last left in — check it by hand and set it manually if it is locked outside the intended window. The table can stay; nothing else reads it.

## Open Questions

- Should a `lock` leave `ViewChannel` untouched? Assumed yes — students should be able to read the channel and the announcement after it closes; only `SendMessages` is toggled. The PID's open helper sets `ViewChannel: true` and its close helper does not mention it, which is consistent with this reading.
- Should the open announcement `@mention` anyone? Not in this change — a nightly ping of `@everyone` to 5,000 members is a decision for whoever runs the server, not a default.
- Should `POST /open` and `/lock` be recorded anywhere? They are logged and become the in-memory last-run outcome, which disappears on restart. If "who unlocked the channel at 2 AM" ever becomes a question, that is the moment to add the run-history table this change deliberately left out.
