## 1. Author resolution

- [x] 1.1 Add `findMemberByDiscordUserId(discordUserId)` to `src/repositories/member.repository.ts`, returning the row or `null`, selecting at least `id`, `discordUserId`, `discordUsername`, `isInGuild`.
- [x] 1.2 Document in place why this lookup deliberately does **not** filter `isInGuild: true`, unlike `findActiveMemberByUsername` and every other directory read — a departed member's row is still the correct owner of a message they sent while present.
- [x] 1.3 Export the new function from the `memberRepository` object.

## 2. Ingestion core

- [x] 2.1 Create `src/lib/discord/message.ingest.ts` exporting `ingestDailyUpdateMessage(message)`.
- [x] 2.2 Resolve the author via `findMemberByDiscordUserId(message.author.id)`.
- [x] 2.3 On a miss, fetch the `GuildMember` from the guild and upsert them via the existing `upsertMemberPayload()` from `member.sync.ts`, then re-resolve. Never write `discord_members` directly.
- [x] 2.4 If the fetch fails or returns no member, log a warning naming the author ID and message ID, and return without storing.
- [x] 2.5 Derive `messageDate` with `getDhakaDate(message.createdAt)` and pass `messageCreatedAt: message.createdAt` — never `new Date()`.
- [x] 2.6 Persist through `dailyUpdateRepository.createDailyUpdate` with `memberId`, `discordMessageId`, `channelId`, `message`, `messageDate`, `messageCreatedAt`.
- [x] 2.7 React with ✅ only when the repository reports `created: true`; wrap the reaction in its own try/catch so a permissions failure or a deleted message logs and leaves the stored row intact.
- [x] 2.8 Wrap the whole function so no error escapes to the gateway; log with the message ID and author ID for traceability.

## 3. Event handler and filtering

- [x] 3.1 Create `src/lib/discord/events/messageCreate.ts` exporting `handleMessageCreate(message)`.
- [x] 3.2 Ignore messages with no guild (DMs) and messages from any guild other than the configured one.
- [x] 3.3 Ignore messages whose channel ID is not the configured `DAILY_UPDATE_CHANNEL_ID`; never match on channel name.
- [x] 3.4 Ignore bot authors (including the bot's own channel-open/close embeds) and Discord system messages.
- [x] 3.5 Ignore messages with empty trimmed content **and** no attachments and no embeds; keep attachment-only messages, which are valid submissions.
- [x] 3.6 Delegate everything that survives the filters to `ingestDailyUpdateMessage`.

## 4. Client intents and degraded-mode login

- [x] 4.1 In `src/lib/discord/client.ts`, replace the fixed `discordClient` export with a module-level binding plus a `getDiscordClient()` accessor; do not export the raw binding.
- [x] 4.2 Add a client factory that takes an `includeMessageContent` flag and builds the `Client` with `Guilds` + `GuildMembers`, adding `GuildMessages` + `MessageContent` when set.
- [x] 4.3 On the first login attempt, request all four intents.
- [x] 4.4 Detect the `disallowed intents` rejection, log an error naming the *Message Content Intent* toggle in the Developer Portal, then rebuild the client without `MessageContent` and retry login exactly once.
- [x] 4.5 If the retry also fails, log that the *Server Members Intent* is the likely cause and return without running the bot; the HTTP API must keep serving.
- [x] 4.6 Track `ingestionEnabled` at module level, set from which login attempt succeeded, and expose it via a getter alongside `isDiscordConnected()` / `getBotTag()`.
- [x] 4.7 Reset the `handlersRegistered` guard when the client is rebuilt so handlers attach to the client that actually logged in.
- [x] 4.8 Register `Events.MessageCreate` → `handleMessageCreate` only when `ingestionEnabled` is true, and log a plain warning when it is skipped.
- [x] 4.9 Verify `stopDiscordBot()` destroys whichever client is current.

## 5. Observability

- [x] 5.1 Add a `dailyUpdate: { ingestionEnabled, reason }` block to the payload returned by `getSyncStatusFromDB()` in `src/modules/discord/discord.service.ts`.
- [x] 5.2 Update `postman-collection.json` for the extended `GET /api/discord/sync/status` response.

## 6. Documentation

- [x] 6.1 Document the ingestion path in `CLAUDE.md`: snowflake-based author resolution, the just-in-time directory repair, `messageDate` from `message.createdAt`, and the ✅-on-first-write rule.
- [x] 6.2 Document the degraded-intent behavior in `CLAUDE.md` — why `MessageContent` is not allowed to take down member sync, and where to look when ingestion is silently off.
- [x] 6.3 Note the *Message Content Intent* prerequisite in `.env.example` alongside the existing Discord variables, and tick the Phase 4 boxes in `PRD.md`'s roadmap.

## 7. Verification

- [x] 7.1 `bun run lint` and `bun run build` pass.
- [x] 7.2 Post a message in `#daily-update`: one row appears with the correct `member_id`, `message_date`, and `message_created_at`, and the message gets ✅.
- [x] 7.3 Post a second message from the same member the same day: a second row is created, both are acknowledged.
- [x] 7.4 Post in another channel and post as a bot: no rows written.
- [x] 7.5 Post an attachment-only message: a row is written with empty content and the message is acknowledged.
- [x] 7.6 Delete the author's `discord_members` row, post again, and confirm the member is re-created through the shared upsert and the message is stored.
- [x] 7.7 Confirm `message_date` is the Dhaka calendar date under a non-Dhaka `TZ` (e.g. run with `TZ=UTC`).
- [x] 7.8 Temporarily disable the Message Content Intent in the portal and restart: the bot logs the named error, logs in on the retry, member sync runs, ingestion is skipped, and `GET /api/discord/sync/status` reports it disabled. Re-enable afterwards.
