## Why

Every evening an administrator hand-posts the same message into `#attendance`: today's date, the attendance form link, the update format, the closing time, and the termination warning — then manually pings the roles that need to see it. It is the one part of the daily cycle that is still a person typing at 7 PM, so it is skipped when nobody is around, and when it is posted the closing time in the text drifts away from the schedule that actually locks `#daily-update`.

## What Changes

- Add an admin-editable **announcement template** stored in the database, seeded with the current Bangla message. Placeholders (`{{date}}`, `{{close_time}}`, `{{daily_update_channel_id}}`, `{{attendance_form_link}}`, `{{termination_day}}`) are substituted at post time, so the closing time in the message is the closing time the scheduler will actually enforce.
- Add an **independent daily schedule** for the announcement — its own time (default 19:00 Dhaka), its own weekdays, its own enabled flag — registered as its own `node-cron` task. It shares no state with the `#daily-update` open/lock window: changing one never moves the other, and disabling one leaves the other running.
- Post the rendered message to the **attendance channel** (`ATTENDANCE_CHANNEL_ID`, already validated in config but not yet used by any code path). The `#daily-update` open/lock embeds are untouched.
- Add a **structured mention allowlist** on the template: role IDs, member handles, and an explicit `@everyone` flag, stored as data beside the text. `allowedMentions` is built from that list only and never parsed out of the message body, so a stray `@everyone` typed into the text cannot ping ~5,000 students.
- Add a **once-per-day claim** on the send, so a process restart at 19:00, a manual send racing the cron, or a second replica cannot post the announcement twice into a channel the whole program reads.
- Add admin endpoints under `/api/announcement`: read the template and schedule with a rendered preview, update either, and post immediately. All `auth(ADMIN)`.
- Record every send attempt (posted, skipped-already-sent, or failed with the Discord reason) and report the most recent outcome, so a missing `Send Messages` permission on the attendance channel surfaces in the API rather than only in the logs.

Not in scope: the attendance channel's own permissions. It is configured in Discord as read-plus-react for members, and this change never edits an overwrite there — `channel.state.ts` remains the only module that edits a channel's permissions, and it stays scoped to `#daily-update`.

## Capabilities

### New Capabilities

- `attendance-announcement-template`: the stored, admin-editable message — its placeholders and how each resolves, the structured mention allowlist and the guarantee that mentions are never parsed from the body, validation of what an admin may save, and the rendered preview.
- `attendance-announcement-delivery`: posting the rendered message to the attendance channel — the independent daily schedule, the manual send, the once-per-day claim, and how a failed or skipped send is recorded and reported.

### Modified Capabilities

None. `channel-schedule-automation` and `schedule-configuration` keep their current requirements: the announcement reads the stored close time to render `{{close_time}}`, but changes nothing about when or how `#daily-update` opens and locks.

## Impact

- **Schema**: new `prisma/schema/announcement.prisma` — one keyed template/schedule row plus a per-day send log. Requires a migration and `bunx prisma generate`.
- **New code**: `src/repositories/announcement.repository.ts`, `src/lib/discord/announcement.ts` (the only module that posts to the attendance channel), `src/lib/scheduler/announcement.scheduler.ts`, `src/modules/announcement/` (routes, validation, controller, service).
- **Touched code**: `src/app.ts` (register `/api/announcement`), `src/server.ts` (start/stop the new cron task alongside the channel scheduler, after the gateway reports ready).
- **Config**: no new environment variables. `ATTENDANCE_CHANNEL_ID` moves from validated-but-unused to load-bearing; `SCHEDULER_ENABLED` gates this cron task exactly as it gates the open/lock jobs; `ATTENDANCE_FORM_URL` becomes the source of `{{attendance_form_link}}`.
- **Discord permissions**: the bot needs `Send Messages` on the attendance channel. Without it every announcement fails, which is why the failure is reported through the status endpoint.
- **Docs**: `CLAUDE.md` gains an announcement section; `postman-collection.json` gains the four endpoints.
