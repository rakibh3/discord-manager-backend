## Context

Every piece of the daily-update path exists except the one that writes: `DailyUpdate` is modelled and migrated, `dailyUpdateRepository.createDailyUpdate` is written and already returns `{ record, created }` specifically so a caller can decide whether to react with ✅, and `dailyStatus.repository.ts` joins the table for the dashboard. There is simply no `messageCreate` listener, so the table is permanently empty and every member reads as `MISSING_UPDATE`.

The constraints this design has to work inside:

- **The bot shares a process with Express.** `src/lib/discord/client.ts` is documented as never throwing — a Discord problem must not stop the REST API. Anything added here inherits that contract.
- **`MessageContent` is a privileged intent.** Discord does not degrade gracefully when a client requests a privileged intent that is off: it refuses the entire connection with `Used disallowed intents`. Adding `MessageContent` therefore couples message ingestion to member sync, and member sync is what the public attendance form's membership check depends on (`member.repository.ts` → `isInGuild: true`). A wrong portal toggle would take the whole student-facing form down, which is the same failure mode the departure guard exists to prevent.
- **Ingestion is not HTTP-scoped.** Data access belongs in `src/repositories/`, per the layering rule the repository layer was created for. The gateway handler has no `req` to fail and no `AppError` to throw.
- **Golden Rules 1, 5, 6, 7** apply directly: resolve by snowflake, dates in `Asia/Dhaka`, store on arrival, and let unique constraints prevent duplicates.

## Goals / Non-Goals

**Goals:**

- Every non-bot message in `#daily-update` becomes exactly one `daily_updates` row, written as it arrives.
- Attribution is correct even when a student renamed since the last sync, or joined during a gateway gap.
- Message-to-day mapping is correct across the midnight boundary.
- A missing Message Content toggle costs ingestion only — never member sync, never the attendance form.
- The degraded state is visible through the existing admin status endpoint, not only in logs.

**Non-Goals:**

- `messageUpdate` / `messageDelete` handling. The stored row is the message as originally sent.
- Backfilling history from before this ships. `channel.messages.fetch()` over a busy channel is a separate, rate-limited concern and no one is asking for retroactive credit.
- The 6:00 PM open / 11:59 PM lock schedule (Phase 5). Ingestion stores whatever arrives, whenever it arrives; the channel permissions are what enforce the window.
- Content quality rules — minimum length, format, "is this a real update". Out of scope by design: the dashboard shows the text and a human judges it.
- Any change to the dashboard endpoints, which do not exist yet (Phase 7).

## Decisions

### 1. Resolve the author by Discord snowflake, not by handle

The PID's Phase 5 sketch says "normalize `message.author.username`, then upsert user". That is the same mistake the member sync already rejects: handles are mutable, so a rename between sync and posting either misses the row entirely or attributes the update to whoever now holds the old handle. `message.author.id` is immutable.

This needs a new lookup — `member.repository.ts` currently only exposes `findActiveMemberByUsername`, which exists for the form's badge and deliberately collapses "no row" and "left the guild" into `null`. Ingestion needs the opposite: it must distinguish them, because a departed member's row is still a valid attribution target for a message they sent while present.

So: add `findMemberByDiscordUserId(discordUserId)` returning the row or `null`, **without** the `isInGuild` filter, with a comment explaining why this one does not filter while every other read does. That asymmetry is the kind of thing that gets "fixed" by a later reader, so it has to be justified in place.

*Alternative rejected:* reusing `findActiveMemberByUsername`. It would drop updates from anyone who renamed, silently, with no error anywhere — exactly the class of failure this codebase keeps trying to design out.

### 2. Repair the directory in-line from the shared upsert path

When the snowflake lookup returns `null`, fetch the `GuildMember` and call the existing `upsertMemberPayload()` from `member.sync.ts`, then re-resolve. Not a direct `prisma.discordMember.create` — `upsertMemberPayload` carries the username-collision tombstoning and the reactivate-on-rejoin behavior, and a second, simpler write path would drift from it.

Ordering matters: the fetch happens *before* the `daily_updates` insert, because `memberId` is a required FK. If the fetch fails (member left between posting and processing, or the API errors), log and drop the message — there is nothing to attach it to, and inventing a placeholder member row would poison the dashboard denominator.

*Alternative rejected:* skip-and-log without the fetch. Simpler, but the initial sync of ~5,000 members takes tens of seconds and is explicitly not awaited at `ClientReady`; a student posting during that window would silently lose their update.

### 3. `messageDate` from `message.createdAt`, never from `now`

`getDhakaDate(message.createdAt)`, and `messageCreatedAt: message.createdAt`. The repository input type already spells this out. It matters most exactly when the system is busiest — the 23:5x rush before the channel locks — where a message queued behind a slow write would otherwise be filed under the wrong day and show its author as missing.

### 4. Ingestion logic lives in `message.ingest.ts`, separate from the event handler

`src/lib/discord/events/messageCreate.ts` does only the cheap filtering that needs the raw `Message`: guild match, channel match, bot/system author, empty content. `src/lib/discord/message.ingest.ts` owns the sequence — resolve member → repair if needed → derive date → persist → react.

The split follows the existing `events/*.ts` + `member.sync.ts` shape, and it keeps the part worth testing free of a live gateway object.

### 5. Attachment-only messages are ingested; truly empty ones are not

A student who posts a screenshot of their work with no caption has submitted an update. `message.content` will be `''`, and `DailyUpdate.message` is a non-null `String`, so an empty string is stored. The filter is `content.trim() === '' && attachments.size === 0 && embeds.length === 0` → ignore.

This also acts as a safety net for the degraded-intent case: if `MessageContent` were ever missing while `GuildMessages` was present, every message would arrive with empty content and be correctly skipped rather than stored as thousands of blank rows.

### 6. Fail-safe login retry for the privileged intent

`startDiscordBot()` gains a second attempt. First login requests all four intents. If it is rejected with `disallowed intents`, log the exact portal toggle to enable, then retry **once** with `MessageContent` dropped.

The mechanics: `discord.js` fixes intents at construction, so the retry cannot reuse the same `Client`. The module-level `discordClient` export becomes a mutable binding behind a `getDiscordClient()` accessor, or the client is constructed inside `startDiscordBot()` and stored in a module variable. The accessor is preferable — several files import the client today, and a `let` export they read once at import time would leave them holding a dead client. Handler registration moves to run against whichever client wins, and the `handlersRegistered` guard is reset with it.

A module-level `ingestionEnabled` flag records the outcome. `registerHandlers()` skips the `messageCreate` registration when it is false, so the degraded mode is structural rather than a check inside the handler.

*Alternative rejected:* always requiring `MessageContent` (fail hard). One portal checkbox would then lock ~5,000 students out of the attendance form, with the same "no error, just a collapse in success rate" signature the CLAUDE.md warns about for the departure guard. The retry costs one extra login attempt in a failure case that should never happen twice.

*Alternative rejected:* an env flag gating the intent. It can drift from the actual portal state, and the wrong combination produces the silent-blank-rows failure rather than a loud one.

### 7. The status endpoint reports ingestion state

`getSyncStatusFromDB()` in `discord.service.ts` gains a `dailyUpdate: { ingestionEnabled, reason }` block alongside `bot`, `members`, and `lastSync`. Without it, "the intent got turned off" is a log line nobody reads until a month of updates is missing.

### 8. No `AppError`, no HTTP status codes anywhere in this path

`messageCreate` has no request to fail. Every step is wrapped so a database outage, a permissions error on the reaction, or a malformed payload is logged and swallowed. The reaction specifically is best-effort *after* the write: the row is the source of truth, and a missing ✅ is a cosmetic problem while a missing row is a student marked absent.

## Risks / Trade-offs

- **Message Content Intent is off in the portal** → The retry keeps member sync and the form alive; the operator gets a named toggle in the logs and a flag on `/api/discord/sync/status`. The trade-off is a real one: ingestion is silently *off* rather than loudly broken, which is why the status endpoint change is part of this scope and not a follow-up.

- **The mutable client binding touches a load-bearing file** → Smaller than it looks: `grep -rn "discordClient" src/` returns no hits outside `client.ts` itself, so the export has no external consumers today and the accessor can be introduced without a cross-file refactor. The risk is future: a later file that imports the binding directly would work in the happy path and hold a dead client only in the degraded path — the worst place for a bug to hide. Mitigated by not re-exporting the raw binding at all; only `getDiscordClient()` leaves the module.

- **Bursty ingestion around 11:5x PM** → Each message is one `INSERT` on an indexed table; the channel is one channel with at most a few thousand posters spread over six hours. No batching, no queue — Golden Rule 6 forbids deferring, and BullMQ is for outbound DMs where Discord's rate limit is the constraint, not for inbound writes.

- **Directory repair adds a Discord API fetch on the miss path** → Only on the first message from an unrecorded member, and `guild.members.fetch(id)` is a single cached call. If the whole directory were empty (a failed initial sync), this would fetch once per distinct poster rather than storming — acceptable, and the loud sync failure is the real signal in that scenario.

- **A student edits their message to add content after posting** → Their original text is what is stored, and edits are out of scope. Acceptable: the row's existence is what the dashboard and reminders key off, and the content is read by a human who can see the current message in Discord.

- **Duplicate ✅ suppression depends on `created`** → If the process crashes between the insert and the reaction, the message stays stored but unacknowledged, and a replayed event will not re-react. The student sees no ✅ despite being credited. Logged; not worth a reconciliation pass for a cosmetic mismatch.

## Migration Plan

1. **Portal first:** enable *Message Content Intent* under Bot → Privileged Gateway Intents, before deploying. If this is missed, the fallback covers it — but ingestion will be off until it is done.
2. Deploy. No schema change, no migration, no new environment variable.
3. Verify: post a test message in `#daily-update`, confirm the ✅ reaction appears and one `daily_updates` row exists with the correct `message_date`.
4. Verify the degraded path is not active: `GET /api/discord/sync/status` reports ingestion enabled.
5. **Rollback:** revert the deploy. Rows already written stay valid and are simply no longer added to — nothing else reads `daily_updates` for correctness of another table.

## Open Questions

- Should the ✅ emoji be configurable? Hardcoded for now; a server-specific custom emoji would need a config entry and a fallback when the emoji is deleted. Not worth it until someone asks.
- Should ingestion refuse messages posted outside the 6:00 PM–11:59 PM window? Deliberately not, in this change: the channel lock is the enforcement mechanism, and a time check here would double-implement the window in a second place that could disagree with the scheduler. Revisit when Phase 5 lands.
