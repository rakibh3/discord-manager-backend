## Why

`#daily-update` has no submission window. Nothing opens the channel at 6:00 PM and nothing locks it at 11:59 PM, so a student can post at 3:00 AM and be credited for a day that already closed, while ingestion (Phase 4) faithfully stores it. The PID's operational timeline (§14) and Phase 3 (§7) both assume the channel's own permissions are what enforce the window — that is the enforcement mechanism the ingestion design deliberately did *not* duplicate ("the channel lock is the enforcement mechanism; a time check in the handler would double-implement the window").

Hard-coding `0 18 * * *` and `59 23 * * *` would work exactly until the first exam week, holiday, or schedule change, each of which would then need a code change and a deploy. The times belong to the people running the program, not to the source tree — so the schedule is stored, admin-editable, and applied without a restart.

## What Changes

- Add a **persisted, admin-editable schedule** for the `#daily-update` channel: open time, close time, active weekdays, and an enabled flag. Times are `HH:mm` wall-clock in `Asia/Dhaka`; the cron expressions are derived by the backend, never typed by an admin.
- Add a **scheduler** that opens the channel (`SendMessages: true` for `@everyone`) with a green announcement embed at the open time, and locks it (`SendMessages: false`) with a red one at the close time, in `Asia/Dhaka`.
- **Reload on save.** A schedule change destroys and re-registers the cron tasks in place; no restart, no redeploy.
- **Reconcile on boot.** At startup the scheduler computes whether the channel *should* be open right now and corrects the permission overwrite if it disagrees — silently, without an announcement. Without this, a restart at 8:00 PM leaves the channel locked for the rest of the evening and nothing anywhere reports an error.
- Add **manual override endpoints** so an admin can force the channel open or locked immediately — the escape hatch for a missed run or a session that runs late.
- Add a **read endpoint** reporting the stored schedule, the next open/lock times, the channel's live permission state, and the last run's outcome, so a scheduler that is silently failing on a missing bot permission is visible on the dashboard.
- Add the `node-cron` dependency and a `SCHEDULER_ENABLED` environment flag, so exactly one process runs the timed jobs when the API is scaled horizontally.

Not in scope: the reminder queue and its post-midnight run (Phase 6 — it needs Redis), a persisted run-history table, and admin-editable announcement text. The embeds ship with fixed copy.

## Capabilities

### New Capabilities

- `channel-schedule-automation`: The timed behavior — opening and locking `#daily-update` on the configured schedule in `Asia/Dhaka`, the open/close announcements, boot-time reconciliation of the channel's actual state against the schedule, manual admin override, and the containment rules that keep a Discord or database failure inside the scheduler.
- `schedule-configuration`: The stored schedule itself — its singleton shape and defaults, the validation rules for times and weekdays (including the refusal of a window that crosses Dhaka midnight), the admin-only read and update endpoints, the audit of who last changed it, and the requirement that a saved change takes effect without a restart.

### Modified Capabilities

- `discord-bot-runtime`: A second non-HTTP subsystem now shares the process. The runtime's startup and shutdown requirements extend to the scheduler — it starts only after the bot is ready, its failures must not stop the HTTP API or the gateway connection any more than the bot's do, and it must be stopped on `SIGINT`/`SIGTERM`. The bot also gains an operational permission prerequisite (Manage Roles on the channel) which, when missing, must be reported rather than only logged.
- `dhaka-calendar-date`: The capability so far defines a civil *day* in `Asia/Dhaka`. The scheduler needs the current Dhaka *time of day* — to decide, at boot, whether "now" falls inside the window. That derivation must come from the same shared module and be independent of the server's `TZ`, exactly as `getDhakaDate` is.

## Impact

**Code**

- `prisma/schema/schedule.prisma` (new) — the `ChannelSchedule` singleton; `prisma/schema/auth.prisma` gains the `updatedBy` back-relation for the audit field.
- `src/repositories/channelSchedule.repository.ts` (new) — read/create-default/update. The scheduler is not HTTP-scoped, so its data access belongs in the repository layer alongside the attendance domain.
- `src/lib/discord/channel.state.ts` (new) — the permission-overwrite edit plus the announcement embeds; the only place that mutates channel permissions.
- `src/lib/scheduler/channelSchedule.scheduler.ts` (new) — `node-cron` registration, reload, boot reconcile, and the in-memory last-run state.
- `src/modules/schedule/*` (new module, four files) — admin-only routes at `/api/schedule`, registered in `src/app.ts`.
- `src/utils/dhakaDate.ts` — a Dhaka wall-clock helper alongside `getDhakaDate`.
- `src/server.ts` — start the scheduler after the bot, stop it during shutdown.
- `src/config/index.ts`, `.env.example` — `SCHEDULER_ENABLED`.

**Data** — one new table (`channel_schedules`) holding a single row, created on first read with the PID's 18:00 / 23:59 defaults. One migration. No change to any existing table beyond the new FK back-relation.

**Dependencies** — adds `node-cron` (v4, timezone-aware, zero runtime dependencies). No Redis: the reminder queue's BullMQ repeatable jobs are Phase 6, and taking a Redis dependency now would block channel automation on infrastructure it does not need.

**Operational prerequisite** — the bot needs **Manage Roles** on `#daily-update` to edit the `@everyone` overwrite. Without it every open and lock fails; the read endpoint reports it.

**Downstream** — daily-update ingestion becomes bounded by a real window rather than accepting posts at any hour, which is what makes a day's `MISSING_UPDATE` count mean "did not submit in time" instead of "has not submitted yet". The bot's own announcement embeds are already excluded from ingestion by the existing bot-author filter.
