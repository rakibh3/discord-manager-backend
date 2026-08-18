## 1. Schema and generated client

- [x] 1.1 Add `prisma/schema/announcement.prisma` with `AnnouncementTemplate` (`id`, `key @unique`, `body @db.Text`, `terminationDays @default(3)`, `mentionEveryone @default(false)`, `mentionRoleIds String[]`, `mentionUsernames String[]`, `announceTime String`, `daysOfWeek Int[] @default([0,1,2,3,4,5,6])`, `enabled @default(true)`, `updatedById` + `updatedBy User? onDelete: SetNull`, `createdAt`, `updatedAt`), mapped to `announcement_templates`. Comment each non-obvious column the way `schedule.prisma` does — especially why `announceTime` is a `String` and why there is no timezone column.
- [x] 1.2 Add `AnnouncementLog` to the same file (`key`, `announcementDate String` (Dhaka `YYYY-MM-DD`), `attempt Int @default(1)`, `status AnnouncementStatus`, `trigger AnnouncementTrigger`, `renderedMessage @db.Text`, `discordMessageId String?`, `mentionedRoleIds String[]`, `mentionedUserIds String[]`, `unresolvedTargets String[]`, `error String?`, `triggeredById String?` + relation, `createdAt`, `updatedAt`) with `@@unique([key, announcementDate, attempt])`, mapped to `announcement_logs`. Add enums `AnnouncementStatus { SENDING POSTED FAILED }` and `AnnouncementTrigger { SCHEDULED MANUAL }`.
- [x] 1.3 Add the back-relations on `User` in `prisma/schema/auth.prisma` for both new `updatedBy`/`triggeredBy` relations.
- [x] 1.4 Run `bunx prisma migrate dev --name add_announcement_template` and `bunx prisma generate`; confirm `bun run build` typechecks.

## 2. Pure rendering utility

- [x] 2.1 Create `src/utils/announcementTemplate.ts` exporting `ANNOUNCEMENT_PLACEHOLDERS` (`date`, `close_time`, `daily_update_channel_id`, `attendance_form_link`, `termination_day`) and a `TAnnouncementContext` type. No Prisma, no discord.js, no `req` imports in this file.
- [x] 2.2 Implement `renderAnnouncement(body, context)`: substitute every occurrence of each supported placeholder; render `{{daily_update_channel_id}}` as `<#id>`; leave unsupported placeholders untouched.
- [x] 2.3 Implement `findUnsupportedPlaceholders(body)` returning every `{{…}}` token outside the supported set, for save-time validation.
- [x] 2.4 Implement `buildMentionLine({ everyone, roleIds, userIds })` returning the trailing mention line (`@everyone` first when enabled, then `<@&role>`, then `<@user>`), and an empty string when there is nothing to mention.
- [x] 2.5 Export `DEFAULT_ANNOUNCEMENT_BODY` — the Bangla message from `attendenace.txt` with its placeholders intact, **excluding** the trailing "Need to mention roles" line.
- [x] 2.6 Extract `buildCronExpression` from `src/lib/scheduler/channelSchedule.scheduler.ts` into `src/utils/cron.ts`, update the channel scheduler to import it, and confirm no other importer breaks (`grep -rn buildCronExpression src/`).

## 3. Repository layer

- [x] 3.1 Create `src/repositories/announcement.repository.ts` with `ATTENDANCE_ANNOUNCEMENT_KEY = 'ATTENDANCE_DAILY'` and `DEFAULT_ANNOUNCEMENT` (body, `terminationDays: 3`, `announceTime: '19:00'`, all weekdays, enabled, no mentions).
- [x] 3.2 Implement `getOrCreateTemplate()` as an `upsert` with `update: {}` and `include` of the editor select, matching `channelScheduleRepository.getOrCreateSchedule()`.
- [x] 3.3 Implement `updateTemplate({ updatedById, ...fields })` — stores what it is given; coherence checks belong to the service.
- [x] 3.4 Implement `claimDay({ key, announcementDate, attempt, trigger, renderedMessage, triggeredById })` creating a `SENDING` row, and let P2002 propagate for the caller to interpret.
- [x] 3.5 Implement `reclaimFailedDay({ key, announcementDate, attempt })` as an `updateMany` scoped to `status: 'FAILED'`, returning the updated count so a losing caller can tell.
- [x] 3.6 Implement `markPosted(...)` and `markFailed(...)`, `findLogsForDate(key, date)`, `nextAttemptNumber(key, date)`, and `findLastLog(key)`.
- [x] 3.7 Keep the file free of `AppError`, HTTP status codes, and `req` — repositories own Prisma and nothing else.

## 4. Discord posting module

- [x] 4.1 Create `src/lib/discord/announcement.ts` with `resolveAttendanceChannel()` — fetch by `ATTENDANCE_CHANNEL_ID`, require `ChannelType.GuildText`, require `channel.guild.id === config.guildId`, return `null` with a logged reason otherwise. Model it on `resolveReminderChannel` in `dm.ts`.
- [x] 4.2 Implement `resolveMentionTargets({ roleIds, usernames })` — roles via the guild's roles, handles via `memberRepository.findActiveMemberByUsername`; return `{ roleIds, userIds, unresolved }` and never throw.
- [x] 4.3 Implement `postAttendanceAnnouncement({ content, mentions })` sending plain `content` (never an embed — mentions in embeds do not notify) with `allowedMentions: { parse: mentionEveryone ? ['everyone'] : [], roles, users }`.
- [x] 4.5 Send with `enforceNonce: true` and a deterministic `nonce` of `<announcementDate>-<attempt>`, so discord.js's REST retries cannot leave several identical messages in the channel. Added after observing four messages from one logged send.
- [x] 4.4 Return a discriminated result (`{ ok: true, messageId }` | `{ ok: false, error, missingPermission }`), classifying Discord `50013`/`50001` as `missingPermission`. Nothing in this file throws.

## 5. Dispatch orchestration

- [x] 5.1 Create `src/lib/announcement/announcement.dispatch.ts` exporting `dispatchAttendanceAnnouncement({ trigger, force, triggeredById })`.
- [x] 5.2 Sequence: read template → bail if `enabled` is false and the trigger is `SCHEDULED` → read `closeTime` via `channelScheduleRepository.getOrCreateSchedule()` → build the context (`getDhakaDate()`, `config.attendance_form_url`, the daily-update channel ID, `terminationDays`) → render → resolve mentions → claim → post → record.
- [x] 5.3 Claim logic: attempt 1 by default; on P2002 look up the existing row — `POSTED`/`SENDING` means already claimed (return an `already-sent` result carrying the earlier timestamp), `FAILED` means retry through `reclaimFailedDay` and proceed only if it updated a row.
- [x] 5.4 `force: true` claims `nextAttemptNumber()` instead, and a P2002 there is reported as a conflict rather than retried.
- [x] 5.5 Record the outcome with `markPosted`/`markFailed` including `unresolvedTargets`, and keep an in-memory `lastOutcome` (like `lastRun` in the channel scheduler) for the status payload.
- [x] 5.6 Wrap the whole function so nothing throws past its boundary; return a result value for every path.

## 6. Cron task

- [x] 6.1 Create `src/lib/scheduler/announcement.scheduler.ts` mirroring `channelSchedule.scheduler.ts`: `startAnnouncementScheduler`, `reloadAnnouncementSchedule`, `stopAnnouncementScheduler`, `getAnnouncementSchedulerState`.
- [x] 6.2 Gate registration on `config.scheduler_enabled` with a warning log when off; do not add a new environment variable.
- [x] 6.3 Register one task from `buildCronExpression(announceTime, daysOfWeek)` with `{ timezone: DHAKA_TIMEZONE, name: 'attendance-announcement', noOverlap: true }`, calling `dispatchAttendanceAnnouncement({ trigger: 'SCHEDULED' })`.
- [x] 6.4 `destroy()` the task on reload, never `stop()`; skip registration entirely when `enabled` is false.
- [x] 6.5 Deliberately implement **no** boot reconcile, and note why in a comment: a missed announcement must not be posted hours late by a restarting container.
- [x] 6.6 Report `processEnabled`, `running`, `nextRunAt`, and the last outcome from `getAnnouncementSchedulerState()`.

## 7. HTTP module

- [x] 7.1 Create `src/modules/announcement/announcement.validation.ts`: `updateAnnouncementValidationSchema` (all fields optional, empty body rejected) validating `body` (non-empty, no unsupported placeholders), `terminationDays` (positive int), `mentionEveryone` (boolean), `mentionRoleIds` (17-20 digit snowflakes, deduped), `mentionUsernames` (normalized + `DISCORD_USERNAME_REGEX`, deduped), `announceTime` (`timeOfDaySchema`), `daysOfWeek` (0-6, non-empty, deduped), `enabled`; plus `previewValidationSchema` and `sendValidationSchema` (`{ force?: boolean }`).
- [x] 7.2 Create `announcement.service.ts`: `getAnnouncement()` (template + rendered preview + resolved mentions + supported placeholders + schedule + scheduler state + today's send), `updateAnnouncement(payload, adminId)`, `previewAnnouncement(payload)`, `sendAnnouncementNow({ force }, adminId)`.
- [x] 7.3 In `updateAnnouncement`, validate the **rendered** length (body + mention line) against Discord's 2,000-character limit and throw a 400 naming the rendered length and the limit.
- [x] 7.4 In `updateAnnouncement`, call `reloadAnnouncementSchedule()` only when a schedule field changed, inside a try/catch that logs rather than fails the request — the row is already saved.
- [x] 7.5 In `sendAnnouncementNow`, translate the dispatch result: `already-sent` → 409 naming the earlier post time, `missingPermission` → 403 naming the channel and `Send Messages`, bot not connected → 503, other failures → 503 with the Discord reason. `AppError` appears in this file and nowhere else in the feature.
- [x] 7.6 Create `announcement.controller.ts` — every handler wrapped in `catchAsync`, every response through `sendResponse`, no Prisma.
- [x] 7.7 Create `announcement.routes.ts` — `GET /attendance`, `PATCH /attendance`, `POST /attendance/preview`, `POST /attendance/send`, all behind `auth(UserRole.ADMIN)`, with a header comment stating that nothing here is student-facing.
- [x] 7.8 Register `announcementRouter` at `/api/announcement` in `src/app.ts`, before `notFoundRoute`.

## 8. Startup wiring

- [x] 8.1 In `src/server.ts`, start the announcement scheduler alongside `startChannelScheduler()` after `onDiscordReady()` resolves, in its own try/catch so a failure cannot take down the channel scheduler or the API.
- [x] 8.2 Add `stopAnnouncementScheduler()` to the `SIGINT`/`SIGTERM` shutdown path.

## 9. Verification

- [x] 9.1 `bun run lint` and `bun run build` are clean.
- [x] 9.2 `GET /api/announcement/attendance` on a fresh database returns the seeded Bangla template, a rendered preview with today's Dhaka date and the stored `closeTime`, and `today.posted: false`.
- [x] 9.3 Change the daily-update `closeTime` via `PATCH /api/schedule/daily-update`, re-read the announcement, and confirm the preview reflects the new time without the body being edited.
- [x] 9.4 Save a body containing `{{attendance_link}}` and confirm a 400 naming the unsupported placeholder and listing the supported ones.
- [ ] 9.5 Put the literal text `@everyone` in the body with the flag off, `POST /attendance/send`, and confirm in Discord that nobody is notified; then confirm an allowlisted role **is** notified. **Mostly done:** with `@everyone` in the body and the flag off, the resolved mention line contained only the allowlisted handle; with the flag on, a real post came back with `mentions.everyone === true` on the stored Discord message. The remaining gap is a role-ID entry, which needs a real role from the guild.
- [x] 9.6 `POST /attendance/send` twice and confirm the second returns 409 and posts nothing; then `{ force: true }` and confirm a second message and a second `attempt` row. A plain send against an already-`POSTED` day returned 409 naming the earlier post and left the row count at 1; `{ "force": true }` then posted message `1539058182494887992` and recorded `attempt` 2.
- [x] 9.10 Confirm `enforceNonce` collapses a REST retry. The forced send took 15.7s end to end, Discord stamped the message at 23:47:45 and our success log landed at 23:48:00 — a full 15s timeout window between the message existing and the client hearing about it, i.e. a retry. The channel contains exactly **one** bot message. Same signature before the fix (53s gap) produced four.
- [ ] 9.7 Set `announceTime` to two minutes out, confirm the reported `nextRunAt` moves without a restart and the task fires once; then set `enabled: false` and confirm the next run does not fire while `#daily-update` still opens and locks normally. **Partly done:** `announceTime` 20:30 on days [1,3,5] moved `nextRunAt` to the correct Wednesday without a restart; `enabled: false` gave `running: false` / `nextRunAt: null`; the channel scheduler's `nextOpenAt` was unchanged throughout. Watching the task actually fire is left to a human.
- [ ] 9.8 Temporarily remove the bot's `Send Messages` on the attendance channel, trigger a send, and confirm a 403 and a permission failure reported as the last outcome; restore the permission and confirm a retry on the same day succeeds. **Not done:** needs Discord permission changes.
- [x] 9.9 Confirm the posted announcement creates no `daily_updates` row and does not appear on the daily status dashboard.

## 10. Documentation

- [x] 10.1 Add an announcement section to `CLAUDE.md` covering: the allowlist-only mention rule and why `parse: []` matters here, why plain content instead of an embed, the once-per-day claim and the `SENDING`-before-send ordering, the independence from the channel schedule, `SCHEDULER_ENABLED` gating, the absence of a boot reconcile, and the `Send Messages` requirement on the attendance channel.
- [x] 10.2 Add the four endpoints to `postman-collection.json`.
- [x] 10.3 Note in `.env.example` that `ATTENDANCE_CHANNEL_ID` is now load-bearing and the bot needs `Send Messages` there.
