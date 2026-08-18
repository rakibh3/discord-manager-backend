## Context

The program already automates the evening cycle everywhere except its first step. `channelSchedule.scheduler.ts` opens and locks `#daily-update` on a stored schedule, `message.ingest.ts` files what students post, and the BullMQ queue chases whoever missed it after midnight. The message that tells ~5,000 students to do any of that is still typed by hand into `#attendance` each evening, with the closing time copied from memory.

Three pieces of the existing system are already shaped to receive this feature:

- `ATTENDANCE_CHANNEL_ID` is validated in `src/config/discord.ts` and used by nothing.
- `channel_schedules` holds the authoritative `closeTime`, so the announcement can state the time the scheduler will actually enforce rather than a second copy of it.
- `dm.ts` established the mention-safety pattern for this codebase — an explicit `users` list with `parse: []` — for exactly the situation this feature is in: bot-authored text going to a channel thousands of students read.

The constraints that shaped the decisions below: the announcement must not become a second way to lock or unlock a channel; it must not be able to mass-ping by accident; and it must not post twice, because a duplicate in `#attendance` is visible to the entire program.

## Goals / Non-Goals

**Goals:**

- The evening announcement posts itself, on a schedule administrators control from the dashboard, in `#attendance`.
- The message is data. Admins edit the body, the termination-day threshold, and the mention targets without a deploy.
- Mentions are structured and auditable — `@everyone` is a deliberate, recorded choice, never a side effect of text.
- One post per Dhaka day, guaranteed by the database rather than by timing.
- The announcement's schedule is genuinely independent of the `#daily-update` window: same default hour today, no shared state.

**Non-Goals:**

- Editing the attendance channel's permissions. It is configured in Discord as read-and-react for members. `channel.state.ts` stays the only module that edits an overwrite, and it stays scoped to `#daily-update`.
- Multiple templates, multiple target channels, or per-day one-off messages. One keyed row, one channel, one daily message.
- Editing or deleting an announcement after it is posted, and reacting to reactions on it.
- Moving the announcement onto BullMQ. It is one message a day to one channel; a queue would add Redis as a dependency of a feature that does not need it.

## Decisions

### The template and its schedule live in one keyed row, in a new model

`prisma/schema/announcement.prisma` adds `AnnouncementTemplate` (key `ATTENDANCE_DAILY`), holding both the message (`body`, `terminationDays`, `mentionEveryone`, `mentionRoleIds`, `mentionUsernames`) and its schedule (`announceTime` as `HH:mm` `String`, `daysOfWeek` `Int[]` in cron's 0=Sunday numbering, `enabled`), plus `updatedById`/`updatedAt` for the audit.

*Why not extend `ChannelSchedule`:* that row means "when may students post", and it is read by the boot reconcile and the open/lock jobs. Hanging a message body and a third time on it would make the announcement's schedule a field of the submission window — precisely the coupling the requirement rules out — and `getOrCreateSchedule()` would start returning a wide row to a cron callback that needs two strings.

*Why `String` for `announceTime`:* the same reason the existing schedule uses it. A `DateTime` round-trips through a timezone-carrying JS `Date` and can be shifted by a driver or the server's `TZ`. `HH:mm` compares lexicographically and cannot be silently moved. There is no timezone column; `DHAKA_TIMEZONE` is reported, never accepted.

*Lazy creation, not a seed step:* `getOrCreateTemplate()` is an `upsert` with `update: {}`, matching `channelScheduleRepository.getOrCreateSchedule()` — safe against the cold-deploy race where the scheduler and a dashboard request arrive together, and it does not rewrite `updatedAt` on every tick. The default body is the Bangla message from `attendenace.txt` with its placeholders intact; the trailing "Need to mention roles" line is an instruction to the implementer, not part of the message, and is not stored.

### Rendering is a pure function, in `src/utils/announcementTemplate.ts`

`renderAnnouncement(template, context)` takes the body and a context object (`date`, `closeTime`, `dailyUpdateChannelId`, `attendanceFormLink`, `terminationDay`) and returns the final string. It touches no Prisma, no Discord, and no `req`, so the preview endpoint, the manual send, and the cron task all produce the same output from the same inputs — the only way a preview is worth anything.

The same module exports the placeholder list and `findUnsupportedPlaceholders(body)`, used by validation on save. `{{daily_update_channel_id}}` renders as `<#id>`, so it is a working channel link rather than a bare number.

*Unknown placeholders:* rejected on save. At post time, a body that somehow contains one (saved before a placeholder was retired) is posted as-is with the literal text and the fact recorded — a slightly wrong message beats no message at 7 PM.

### Plain message content, not an embed

The open/lock announcements are embeds; this one is not. **Mentions inside an embed do not notify anyone** — Discord resolves pings only in `content`. Since notifying roles is half of what this feature is for, the message must be plain content. It also keeps the Bangla body exactly as an admin typed it.

Mention targets are appended as a final line after the body rather than substituted into it. The demo message carries its mentions at the end, and a `{{mentions}}` placeholder would let an admin delete the mentions by editing the text — a silent failure of the feature's second purpose.

### Mentions are an allowlist, resolved at post time, never parsed from the body

`src/lib/discord/announcement.ts` builds:

```
allowedMentions: {
  parse: mentionEveryone ? ['everyone'] : [],
  roles: resolvedRoleIds,
  users: resolvedUserIds,
}
```

`parse: []` is what makes a stray `@everyone` in the body inert; the explicit `roles`/`users` lists are what make an allowlisted target ping. Handles resolve through the existing `memberRepository.findActiveMemberByUsername` — the same normalized, exact-match, `isInGuild: true` lookup the attendance form uses, so "who counts as a member" has one definition. Role IDs resolve against the guild's roles.

*Resolution at post time, not save time:* a member can leave and a role can be deleted between the save and the 7 PM run. An unresolved target is dropped from that post and recorded on the send log; it never blocks the announcement, because a missing ping is worth far less than the message itself. Shape is still validated on save (snowflake for roles, `DISCORD_USERNAME_REGEX` for handles) so obvious mistakes fail where an admin is watching.

*`@everyone` as its own boolean:* it cannot be expressed as a role ID entry without an admin discovering that the guild ID doubles as the `@everyone` role ID — an accident waiting in a text field. A dedicated flag, default off, with `updatedBy` recorded, makes turning it on a deliberate act.

### One post per Dhaka day, claimed in the database

`AnnouncementLog` carries `@@unique([key, announcementDate, attempt])` with `attempt` defaulting to 1, plus `status` (`SENDING` | `POSTED` | `FAILED`), `trigger` (`SCHEDULED` | `MANUAL`), `renderedMessage`, `discordMessageId`, resolved and unresolved mention targets, and `error`.

The claim is a `create` with `attempt: 1`. A P2002 means the day is taken: the cron task logs and stops; a manual send returns 409 naming the earlier post's time. This is the same reasoning as `@@unique([memberId, attendanceDate])` — a read-then-write check does not survive two callers arriving in the same millisecond, and here the two callers are exactly the ones that will (a restart at 19:00, or an admin clicking Send while cron fires).

*Retry after failure:* a `FAILED` row is re-claimed with an `updateMany` scoped to `status: 'FAILED'`, the same scoped-claim trick as `markReminderProcessing`. Zero rows updated means another caller took it. A failed send therefore does not consume the day.

*Deliberate second post:* `POST /send` with `{ force: true }` inserts the next `attempt` for today. The read of the current attempt count is safe to be non-atomic here, because a losing race hits the unique constraint and reports a conflict rather than posting twice.

*The claim is not sufficient on its own.* It guarantees the send is *called* once per day; it says nothing about how many HTTP requests that one call becomes. discord.js retries a REST request that times out, and Discord may already have created the message before the response was lost — so one logical send can leave several identical messages in the channel while the log records only the last message ID. This was observed during implementation: four messages from one send, 53 seconds between the claim row and the success log. Every send therefore also carries `enforceNonce: true` with a deterministic `nonce` (`<announcementDate>-<attempt>`, inside Discord's 25-character limit), which makes Discord return the existing message rather than create a second. The nonce covers the seconds of one call's retries; the claim covers the day. Both are required.

*Why `SENDING` before the send, not after:* the alternative — record after a successful post — leaves the window where a crash between post and write lets the next run post a duplicate. Claiming first inverts the residual risk to "claimed but never posted", which is visible in the status endpoint as a `SENDING` row and is recoverable by a manual send. A duplicate mass-mention is not recoverable.

### Cron in its own task, gated by the existing switch

`src/lib/scheduler/announcement.scheduler.ts` registers exactly one `node-cron` task, `<mm> <HH> * * <days>` derived from the row, `timezone: DHAKA_TIMEZONE`, `noOverlap: true`, and exposes `startAnnouncementScheduler` / `reloadAnnouncementSchedule` / `stopAnnouncementScheduler` / `getAnnouncementSchedulerState`, mirroring the channel scheduler's surface. `destroy()` on reload, never `stop()` — a stopped task keeps its old expression and would later fire on a schedule nobody can see in the database.

`buildCronExpression` is extracted from `channelSchedule.scheduler.ts` into `src/utils/cron.ts` and imported by both. One derivation of a cron expression, not two that drift.

`SCHEDULER_ENABLED` gates this task exactly as it gates open/lock: `node-cron` is process-local, so N replicas would post N announcements. No new environment variable — a second flag for the same class of constraint is a second thing to get wrong. The manual send and the status read work on every process.

*There is no boot reconcile.* A missed announcement is not a state to correct; posting "today's announcement" at 21:40 because a container restarted then would be worse than the gap. The status endpoint reports that today has not been posted and the manual send exists for that case.

### Orchestration sits between the scheduler and Discord

`src/lib/announcement/announcement.dispatch.ts` holds the sequence — read template → read `closeTime` from `channelScheduleRepository` → render → resolve mentions → claim → post → record outcome — and returns a result value. It never throws, because one of its two callers is a cron callback with no request to fail; the other is `announcement.service.ts`, which turns a returned failure into an `AppError` and is the only place in this feature that raises one.

This mirrors `channel.state.ts` (does the Discord work, returns a result) versus `schedule.service.ts` (turns it into HTTP), and keeps `src/lib/discord/announcement.ts` as the single module that writes to the attendance channel.

### API surface

All under `/api/announcement`, all `auth(ADMIN)`; no part of this is student-facing, unlike `attendanceRouter`.

| Route | Purpose |
| --- | --- |
| `GET /attendance` | template + schedule + rendered preview + resolved mentions + scheduler state + today's send |
| `PATCH /attendance` | body, terminationDays, mentions, announceTime, daysOfWeek, enabled — any subset, empty body rejected |
| `POST /attendance/preview` | render an unsaved body without storing it |
| `POST /attendance/send` | post now; `{ force?: boolean }` |

One `PATCH` rather than separate message and schedule endpoints: it is one row, and `PATCH /api/schedule/daily-update` already establishes the shape. The service reloads the cron task only when a schedule field actually changed, and — like `updateSchedule` — a reload failure is logged rather than failing a request whose write already succeeded.

## Risks / Trade-offs

- **An admin enables `@everyone` and the announcement pings ~5,000 students nightly** → The flag is off by default, is its own field rather than free text, is reported in `GET /attendance`, and records who set it. The dashboard should confirm it; the API cannot.
- **The bot lacks `Send Messages` on the attendance channel** → Every send fails silently apart from the logs, the same failure mode as `Manage Roles` on `#daily-update`. Mitigated the same way: the permission error is classified distinctly and surfaced as the last outcome on `GET /attendance`.
- **Claimed but never posted** (crash between claim and send) → Leaves a `SENDING` row, so that day self-blocks. Visible in the status response; a manual send with `force` recovers it. Accepted deliberately as the safer half of the trade against a duplicate mass-mention.
- **Rendered message exceeds Discord's 2,000-character limit** → Checked on save against the rendered output plus the mention line, not the raw body. Bengali text is counted the same way Discord counts it (UTF-16 length), so the check is conservative rather than optimistic.
- **`closeTime` is read from the daily-update schedule, coupling the two rows** → Deliberate: it is a read of a value, not shared control. The alternative is a second stored closing time that drifts from the one that actually locks the channel, which is the bug this feature exists to prevent.
- **Extracting `buildCronExpression` touches a working scheduler** → Pure function, no behavior change, one import updated; the alternative is two copies of the derivation.
- **No test framework in the project** → The pure renderer and the cron-expression builder are the parts most worth testing and are written to be callable without Prisma or Discord, so they can be covered when a framework lands. Until then, verification is the manual checklist in `tasks.md`.

## Migration Plan

1. Add `prisma/schema/announcement.prisma`; `bunx prisma migrate dev --name add_announcement_template`; `bunx prisma generate`.
2. Deploy. On first read the template row is created with the current message and 19:00 / all days / enabled — matching what is posted by hand today, so behavior does not change silently.
3. Grant the bot `Send Messages` on the attendance channel before the first 19:00 after deploy. Confirm via `GET /api/announcement/attendance`.
4. Verify with `POST /attendance/preview` and one `POST /attendance/send`, then let the schedule take over. Stop posting the message by hand.

**Rollback:** set `enabled: false` via `PATCH /attendance` — no deploy needed, the row and the history are kept. Full rollback is reverting the code; the tables are additive and referenced by nothing else.

## Open Questions

- The default for `terminationDays` is assumed to be **3** consecutive missed days. Confirm against the program's actual policy; it is one field edit either way.
- The attendance channel's members-can-react-only permissions are assumed to be already configured in Discord. This change does not set them and will not detect them.
