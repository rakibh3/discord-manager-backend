# API Integration Guide (Backend → Next.js Frontend)

Complete reference for every endpoint this backend exposes, plus how to consume it from the Next.js 16 App Router frontend in `../frontend`.

Everything below was read out of the source (`src/modules/**`, `src/middlewares/**`, `src/errors/**`, `src/repositories/**`) — response shapes are the actual `sendResponse` payloads, not a spec.

---

## Table of contents

1. [Deployments and base URLs](#1-deployments-and-base-urls)
2. [Response envelope](#2-response-envelope)
3. [Error envelopes (there are five, and they differ)](#3-error-envelopes-there-are-five-and-they-differ)
4. [Authentication — the four things that will bite you](#4-authentication--the-four-things-that-will-bite-you)
5. [Dates: everything is an Asia/Dhaka civil date](#5-dates-everything-is-an-asiadhaka-civil-date)
   5A. [Multiple Discord servers](#5a-multiple-discord-servers)
6. [Recommended Next.js architecture](#6-recommended-nextjs-architecture)
7. [The integration layer (copy-paste starting point)](#7-the-integration-layer-copy-paste-starting-point)
8. [Endpoint reference](#8-endpoint-reference)
   - [8.1 Auth — `/api/auth`](#81-auth--apiauth)
   - [8.2 Users — `/api/users`](#82-users--apiusers)
   - [8.3 Discord — `/api/discord`](#83-discord--apidiscord)
   - [8.4 Schedule — `/api/schedule`](#84-schedule--apischedule)
   - [8.5 Reminders — `/api/reminders`](#85-reminders--apireminders)
   - [8.6 Attendance (public) — `/api/attendance`](#86-attendance-public--apiattendance)
   - [8.6A Roster — `/api/roster`](#86a-roster--apiroster)
   - [8.7 Attendance announcement — `/api/announcement`](#87-attendance-announcement--apiannouncement)
   - [8.8 Daily status — `/api/daily-status`](#88-daily-status--apidaily-status)
   - [8.9 Root](#89-root)
9. [Rate limits](#9-rate-limits)
10. [Caching and revalidation strategy per endpoint](#10-caching-and-revalidation-strategy-per-endpoint)
11. [Live progress without SSE](#11-live-progress-without-sse)
12. [The public attendance form (separate app)](#12-the-public-attendance-form-separate-app)
13. [Not implemented yet](#13-not-implemented-yet)
14. [Gotcha checklist](#14-gotcha-checklist)

---

## 1. Deployments and base URLs

There are **two** browser front-ends and they are separate deployments. The backend's CORS allowlist is built from exactly these two env vars (`src/config/index.ts`), and it runs with `credentials: true`, so `'*'` is never an option.

| App                    | Dev origin              | Backend env var       | Talks to                 |
| ---------------------- | ----------------------- | --------------------- | ------------------------ |
| Admin dashboard        | `http://localhost:3000` | `APP_URL`             | every `/api/*` route     |
| Public attendance form | `http://localhost:3000` | `ATTENDANCE_FORM_URL` | `/api/attendance/*` only |

Backend dev URL: `http://localhost:8000` (`PORT` in `.env`). API prefix: `/api`.

Frontend env (`frontend/.env.local`):

```bash
# Server-only. Never prefix with NEXT_PUBLIC_ — the admin API is reached from
# the Next server, so the browser never needs this value.
API_BASE_URL=http://localhost:8000/api

# Only the public attendance form needs a browser-visible base URL, because its
# verify-user call fires on a keystroke debounce (see §12).
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
```

If you add a new origin (a preview deployment, a staging host), it must be added to `APP_URL`/`ATTENDANCE_FORM_URL` on the backend — both accept a comma-separated list.

---

## 2. Response envelope

Every successful response goes through `sendResponse` (`src/utils/sendResponse.ts`):

```jsonc
{
  "success": true,
  "statusCode": 200, // duplicated in the body, not just the HTTP status
  "message": "…", // human-readable, safe to surface in a toast
  "meta": {
    // present ONLY on paginated list endpoints
    "page": 1,
    "limit": 50,
    "total": 137,
  },
  "data": {}, // the payload — always nested here
}
```

**The payload is always inside `data`.** Flags like `verified` and `alreadySubmitted` live at `data.verified`, not at the top level. Type your client as `ApiResponse<T>` and unwrap once, centrally.

`meta` is `undefined` (omitted from JSON) on non-paginated endpoints.

---

## 3. Error envelopes (there are five, and they differ)

`src/errors/globalErrorHandler.ts` is the single formatter, but its branches emit **different shapes**. A frontend error helper must handle all of them. Note that **no error response contains `statusCode` in the body** and none contains `data`.

### 3a. Zod validation → HTTP 400

```jsonc
{
  "success": false,
  "message": "Discordusername Enter A Valid Discord Username: 2-32 Characters …",
  "errorDetails": {
    "issues": [
      {
        "path": "DiscordUsername",
        "message": "Enter A Valid Discord Username: …",
      },
    ],
  },
  "stack": "…", // development only
}
```

> ⚠️ **Every word is title-cased.** `handleZodValidationError` runs `str.replace(/\b\w/g, toUpperCase)` over both the field path and the message. So a carefully written backend message arrives as `"Enter A Valid Discord Username: 2-32 Characters Using Only Lowercase Letters…"`. Do **not** render these verbatim in polished UI. Map `errorDetails.issues[].path` (lowercase it first) to your own copy, and keep the server message only as a fallback.

Field paths are the **last** path segment, title-cased: `openTime` → `OpenTime`, `daysOfWeek[1]` → `DaysOfWeek`.

### 3b. `AppError` (business rules) → its own status

```jsonc
{
  "success": false,
  "message": "A reminder broadcast for 2026-08-16 is already processing (id …). Wait for it to finish, or cancel it first.",
  "errorDetails": { "statusCode": 409 },
  "stack": "…",
}
```

These messages are written for humans and **are safe to display directly**. Every 4xx/5xx a controller raises deliberately is this shape.

### 3c. Prisma duplicate (P2002) → 409

```jsonc
{ "success": false, "message": "Duplicate Error", "errorMessage": "unknown field already exists!", "errorDetails": { … } }
```

Note the message lives in **`errorMessage`**, not `message`, and `errorMessage` reads `unknown field` because `err.meta.target` is `undefined` under the `@prisma/adapter-pg` driver adapter. The one duplicate a user can actually cause (a second attendance submission) is intercepted in `attendance.service.ts` and re-thrown as an `AppError` (3b) that names the date, so you should never see this shape from the form.

### 3d. Prisma not-found (P2025) → 404

```jsonc
{ "success": false, "message": "Record not found", "errorMessage": "…", "errorDetails": { … } }
```

**This is what a login with an unknown email returns** (`findUniqueOrThrow`), so a 404 from `/api/auth/login` means "no such user". Show the same generic "invalid email or password" copy you show for the 401.

### 3e. Auth middleware short-circuits (they bypass the error handler)

`src/middlewares/auth.ts` writes two responses itself:

```jsonc
// 403 — user is not ACTIVE
{ "success": false, "message": "Account is not active", "errorMessage": "Your account has been suspended. Please contact support." }

// 401 — role not permitted
{ "success": false, "message": "Unauthorized Access!", "errorMessage": "You do not have the necessary permissions to access this resource." }
```

### 3f. Unknown route → 404

```jsonc
{
  "success": false,
  "message": "API Not Found!",
  "path": "/api/nope",
  "date": "2026-08-17T…",
}
```

### 3g. ⚠️ Expired / invalid JWT → **HTTP 500**, not 401

This is the single most important quirk for the frontend. `auth.ts` calls `jwt.verify(...)` directly; a `TokenExpiredError` has no `statusCode`, so it falls through to the generic branch of the error handler:

```jsonc
{
  "success": false,
  "message": "jwt expired",
  "errorDetails": { "name": "TokenExpiredError", "expiredAt": "…" },
}
```

HTTP status is **500**. Same for `"invalid signature"`, `"jwt malformed"`, `"invalid token"`.

Your API client must therefore treat _both_ of these as "needs refresh":

```ts
const NEEDS_REFRESH = new Set([
  'jwt expired',
  'invalid signature',
  'jwt malformed',
  'invalid token',
]);
const isAuthExpired = (status: number, message?: string) =>
  status === 401 || (status === 500 && !!message && NEEDS_REFRESH.has(message));
```

Do not "fix" this by keying only on 401 — you will get a 500 error page every time an access token ages out.

---

## 4. Authentication — the four things that will bite you

Only `ADMIN` accounts exist. Students never log in (they are `discord_members` rows, not `users`).

### 4a. The `Authorization` header carries a **bare token — no `Bearer ` prefix**

```ts
headers: {
  Authorization: accessToken;
} // ✅
headers: {
  Authorization: `Bearer ${accessToken}`;
} // ❌ jwt malformed → HTTP 500
```

`auth.ts` reads `req.headers.authorization` and hands it straight to `jwt.verify`.

### 4b. The backend's own cookies are unusable from a browser

`auth.controller.ts` sets `accessToken`/`refreshToken` cookies with `secure: false, sameSite: 'none'` — a combination browsers reject outright (documented as a known caveat in `CLAUDE.md`). Cross-origin cookie auth **will not work** from the dashboard.

Fortunately login and refresh also return both tokens in the response body. **Read the tokens from `data`, and store them in cookies that Next.js sets itself.** That is the recommended architecture in §6, and it sidesteps the broken cookie flags entirely.

### 4c. Refresh reads the token from a **cookie**, not the body

`POST /api/auth/refresh-token` does `const { refreshToken } = req.cookies`. Calling it from the Next server means sending the header by hand:

```ts
headers: {
  Cookie: `refreshToken=${refreshToken}`;
}
```

The rotated pair comes back in the response body, so you never need to parse `Set-Cookie`.

### 4d. Refresh **rotates** — never fire two at once

Each refresh deletes the old row and creates a new one in a transaction. Two concurrent refreshes with the same token: one wins, the other 401s and the user is logged out. Wrap refresh in a single-flight promise (§7).

### 4e. Token lifetimes

| Token   | JWT `exp`                                    | Backend DB row                            | Cookie `maxAge` (unused by you) |
| ------- | -------------------------------------------- | ----------------------------------------- | ------------------------------- |
| access  | `JWT_ACCESS_EXPIRES_IN` (`7d` in dev `.env`) | —                                         | 1 hour                          |
| refresh | `JWT_REFRESH_EXPIRES_IN` (`30d` in dev)      | **hardcoded 7 days** in `auth.service.ts` | 7 days                          |

The refresh token's **DB row expiry (7 days) is what actually governs** — a 30-day JWT whose row has expired is rejected with 401 `"Invalid or expired refresh token"`. Set your Next session cookie to 7 days, not 30.

---

## 5. Dates: everything is an Asia/Dhaka civil date

`attendanceDate`, `messageDate`, `reminderDate` are `String` in `YYYY-MM-DD`, always the **Asia/Dhaka** calendar day. `openTime`/`closeTime` are `HH:mm` wall-clock strings in the same zone. There is no timezone field to send — the zone is fixed and reported back to you as `"Asia/Dhaka"`.

**Never derive these in the browser with `toISOString().slice(0, 10)`** — that yields the UTC day, and a user in Dhaka at 00:30 would be looking at yesterday's dashboard while the backend files rows under today.

```ts
// frontend/lib/dhaka-date.ts
const DHAKA = 'Asia/Dhaka';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DHAKA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's Dhaka civil date as YYYY-MM-DD, independent of the viewer's clock. */
export function dhakaToday(instant: Date = new Date()): string {
  return dateFormatter.format(instant);
}

/** The Dhaka day N days before `from`. `dhakaYesterday()` is the reminder default. */
export function dhakaDaysAgo(
  days: number,
  from: string = dhakaToday(),
): string {
  const [y, m, d] = from.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d - days));
  return shifted.toISOString().slice(0, 10); // safe: constructed in UTC from a civil date
}

export const dhakaYesterday = () => dhakaDaysAgo(1);
export const DHAKA_TIMEZONE = DHAKA;
```

Render `DateTime` fields (`submittedAt`, `startedAt`, `nextOpenAt`, …) with `timeZone: 'Asia/Dhaka'` too, so an admin travelling abroad reads the same clock as the schedule.

---

## 5A. Multiple Discord servers

The backend now serves **one or many identical Discord servers** from a single deployment. Most of the API is unchanged; these are the differences a front-end has to handle.

### The server list

`GET /api/discord/servers` 🔐 returns the configured servers. Build any server filter from this rather than hard-coding IDs.

```jsonc
{
  "success": true,
  "data": [
    {
      "guildId": "146…",
      "label": "Batch A",
      "name": "Programming Hero B12",
      "reachable": true,
      "unreachableReason": null,
    },
    {
      "guildId": "246…",
      "label": "Batch B",
      "name": null,
      "reachable": false,
      "unreachableReason": "The guild could not be fetched…",
    },
  ],
}
```

**A single-server deployment returns one entry.** Treat one server as the normal case, not a special one: if the list has a single element, hide the filter rather than branching on a separate mode.

### Actions fan out, and can partially succeed

`POST /api/schedule/daily-update/open`, `/lock` and `POST /api/announcement/attendance/send` apply to **every** configured server. Each accepts an optional `guildIds: string[]` to narrow it.

**The important part: partial success is `HTTP 200`, not an error.** If the channel opened in one server and failed in another, the request succeeds and the failure is inside `data`:

```jsonc
{
  "success": true,
  "message": "Daily update channel opened in 1 of 2 server(s)",
  "data": {
    "isOpen": true,
    "summary": { "total": 2, "succeeded": 1, "failed": 1 },
    "servers": [
      {
        "guildId": "146…",
        "label": "Batch A",
        "ok": true,
        "value": { "announced": true },
        "channelId": "…",
      },
      {
        "guildId": "246…",
        "label": "Batch B",
        "ok": false,
        "error": "Missing Permissions",
        "channelId": "…",
      },
    ],
  },
}
```

So **always read `data.summary.failed`** — a `success: true` does not mean every server worked. Only a total failure returns an error status. An unknown `guildId` is a `400` naming it.

### Daily status: one row per PERSON, across every server

A student in two servers is **one person with one day's work**. Posting a daily update in either server makes them COMPLETE in both, submitting attendance once covers both, and they get one reminder DM. The API reflects that: the list returns one row per Discord account, not one per server membership.

- `GET /api/daily-status`, `/counts` and `/export` accept an optional **`guildId`** query parameter. Omitted means every server.
- Every row carries:
  - **`servers`** — `[{ guildId, label }]`, every server this person is in. Narrowed to the filtered server when `guildId` is supplied.
  - **`serverCount`** — how many configured servers hold the account **in total**, never narrowed by the filter. So `servers.length === 1 && serverCount === 2` inside a filtered view means "also in another server", and is worth a small badge.
  - **`memberId`** — the representative member record. Use it for `/members/:memberId`; it resolves to the whole person regardless of which server's record it names.
  - **`memberIds`** — every member record behind the row, aligned with `servers`.
- **Do not try to merge or split rows yourself.** The row is already the person.
- `/counts` returns the seven figures **plus `byServer`**, each entry carrying the same seven figures for one server.

> ⚠️ **`byServer` does NOT sum to the combined totals, and this is not a bug.** They are different units. The combined figures count **people** (someone in two servers counts once); `byServer` counts each server's **memberships** (they count once in each). The difference between the two is exactly the number of people in more than one server. Show them as two separate readings — "N students, of whom X are done today" alongside a per-server breakdown — rather than as a total and its parts.

- A `byServer` entry still credits work done elsewhere: a member of server B who posted in server A counts as submitted in B's figures too.
- `GET /api/daily-status/members/:memberId` describes the whole person. Its `messages` array merges both servers' messages for the date into one timeline ordered by send time, and each message carries **`guildId`** and **`serverLabel`** so the UI can say where it was posted.
- The CSV export gains a leading **`servers`** column listing every server the person is in, `|`-separated, and names the server in the filename when filtered.
- **Reminders follow the same rule**: `GET /api/reminders/targets` and `POST /api/reminders/send` skip anyone whose account posted an update in _any_ server. `targetCount` (recipient rows) can still exceed `uniqueRecipients` (people actually DMed) — that gap is the per-server audit trail, not duplicate sends.

### Date ranges: filtering and reminding over a span of days

Every daily-status endpoint, and both reminder endpoints, accept **either** a single `date` **or** a `from`/`to` pair. The two are mutually exclusive — sending both, or only one half of the pair, is a 400 naming the conflict. Every response states which mode produced it in a `mode` field and echoes the parameters it resolved, so you never have to infer the payload shape from the presence of a field.

| Parameter          | Applies to      | Meaning                                                                                                                      |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `date=YYYY-MM-DD`  | date mode       | One Dhaka day. Unchanged from before.                                                                                        |
| `from=` + `to=`    | range mode      | An inclusive span of Dhaka days. Max **92 days**.                                                                            |
| `daysOfWeek=0,1,2` | range mode only | Which weekdays inside the span count. `0` is Sunday, the same numbering the channel schedule uses. Omitted counts every day. |

The span cap is a blast-radius control, not a performance limit: `from`/`to` reach an irreversible mass DM, so a mistyped year has to be a validation error rather than a broadcast. The dashboard shares the cap so any range you can preview is a range you can act on.

> ⚠️ **`daysOfWeek` is an assertion, not a record.** It is the admin stating which days should count. The system does **not** store when `#daily-update` was actually open on a past day — no such history exists — so nothing verifies the claim. Every range response echoes `daysOfWeek` and the resulting `daysInRange` precisely so the figure always travels with its denominator.

#### The range row: counts instead of a status

In range mode a row still describes **one person**, and still carries `servers`, `serverCount`, `memberId` and `memberIds` exactly as in date mode. What changes is that the single-day `status`, `hasAttendance` and `hasDailyUpdate` are replaced by counts:

| Field              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `daysInRange`      | Counted days — the denominator of everything below.                     |
| `attendanceDays`   | Days the person submitted the attendance form.                          |
| `updateDays`       | Days they posted a daily update, in any server.                         |
| `completeDays`     | Days they did **both**.                                                 |
| `incompleteDays`   | `daysInRange - completeDays` — days not fully done.                     |
| `missedBothDays`   | Days they did **neither**.                                              |
| `missedUpdateDays` | Days with no daily update, whatever attendance says.                    |
| `rangeStatus`      | `ALL_COMPLETE` / `PARTIAL` / `NONE`, derived from `completeDays` alone. |

> ⚠️ **`incompleteDays` and `missedBothDays` are different numbers.** Someone who submits attendance every day and never posts an update has `incompleteDays = daysInRange` and `missedBothDays = 0`. The reminder threshold acts on **`missedBothDays`**, so show that column wherever an admin is about to choose a threshold. There is deliberately no field called `missedDays`.

Range mode filters with `rangeStatus=` and `minMissedBothDays=` instead of `status=`; using the wrong one for the mode is a 400 rather than a filter that silently does nothing. Sorting additionally accepts `sortBy=missedBothDays|completeDays|rangeStatus`.

`/counts` in range mode returns `totalMembers`, `allCompleteMembers`, `partialMembers`, `noneMembers` (which sum to `totalMembers`), plus the person-day totals `attendanceDays`, `updateDays`, `completeDays` and `missedBothDays`. These are **named differently from the seven single-date figures on purpose** — they count person-days, not people. `byServer` carries the same figures and still does not sum to the combined totals, for the same overlap reason as in date mode.

`/members/:memberId` in range mode adds a `days` array — one entry per counted day with `hasAttendance`, `hasDailyUpdate` and that day's four-bucket `status` — alongside the merged message timeline for the range.

#### Reminders over a range

`GET /api/reminders/targets` and `POST /api/reminders/send` take the same period parameters plus two more:

| Parameter       | Default          | Meaning                                                                                                  |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `criterion`     | `MISSING_UPDATE` | `MISSING_UPDATE` = no daily update that day. `MISSING_BOTH` = neither attendance nor an update that day. |
| `minMissedDays` | `1`              | How many counted days the person must have failed to be targeted.                                        |

**The default is deliberate.** `MISSING_UPDATE` with a single `date` is exactly what a broadcast meant before ranges existed, so nothing about your existing send changes. Making `MISSING_BOTH` universal would silently stop reminding a student who fills the attendance form and never posts an update — and the daily-update channel is what this feature exists to drive.

Worked example — _"remind everyone who missed both submissions on at least two of the past three days"_:

```http
POST /api/reminders/send
{
  "from": "2026-08-15",
  "to": "2026-08-17",
  "criterion": "MISSING_BOTH",
  "minMissedDays": 2,
  "message": "..."
}
```

Preview the exact same set first with `GET /api/reminders/targets?from=2026-08-15&to=2026-08-17&criterion=MISSING_BOTH&minMissedDays=2`, or see the same people in the dashboard list with `GET /api/daily-status?from=2026-08-15&to=2026-08-17&minMissedBothDays=2`. All three derive "behind" from one shared query, so they cannot disagree.

A `minMissedDays` higher than the number of counted days is a 400 — it could never be met, and a request that always finds nobody is better refused than run.

#### One broadcast at a time is now an OVERLAP check

A send is refused with **409** while any unfinished broadcast covers a period sharing **any day** with the requested one. A single date inside a running range conflicts; two ranges sharing one day conflict. The refusal names the running broadcast's id and its period so you can cancel it rather than guess which date is blocked.

The guard ignores `criterion`, `minMissedDays`, `daysOfWeek` and `guildIds` — the constraint it protects is the bot's single global DM budget, which does not care how a target list was computed.

Every broadcast now records `reminderStartDate`, `reminderEndDate`, `criterion`, `minMissedDays` and `daysOfWeek` alongside its message. A single-date send stores the same date at both ends. **`reminderDate` no longer exists** on any reminder payload — read the period from the two date fields.

### The public attendance form

`GET /api/attendance/verify-user` now returns a **`servers`** array — every server the handle is currently a member of, each with its own `alreadySubmitted`:

```jsonc
{ "data": { "verified": true, "alreadySubmitted": false, "attendanceDate": "2026-08-18",
  "member": { … },
  "servers": [
    { "guildId": "146…", "label": "Batch A", "alreadySubmitted": true  },
    { "guildId": "246…", "label": "Batch B", "alreadySubmitted": false }
  ] } }
```

Top-level `alreadySubmitted` is `true` only when **every** server already has today's row — a student in two servers who submitted in one still has something to do.

`POST /api/attendance/submit` records attendance in **every** server the handle belongs to, in one transaction, and returns the same `servers` array with a `recorded` flag per server. The student submits once; the form does not ask them to pick a server. A `409` still means "already submitted", and now means it for every server they are in.

`GET /api/attendance/window` is **unchanged** — one shared schedule means one window, so it takes no server parameter. It also carries `emailVerificationRequired`, telling the form whether the email field is checked against the active enrolment roster on submit (a bare boolean — no count, no editor identity, no address).

`GET /api/attendance/verify-email` is the email-side mirror of `/verify-user`: same "always 200" rule, same `data.verified` shape, but it answers whether the address is on the roster rather than whether the handle is in a server. The form uses it as the live badge for the email field, the same way it uses `/verify-user` for the handle field — branch on `data.verified`, never on the HTTP status. See §8.6.

### Status reads are per server

`GET /api/discord/sync/status` reports `servers[]`, each with its own member counts, last sync, reachability, and — importantly — **channel verification**:

```jsonc
{
  "channels": {
    "dailyUpdate": {
      "id": "333…",
      "verified": false,
      "error": "daily-update channel 333… belongs to guild 246…, not 146…",
    },
  },
}
```

That check exists because every server names its channels identically, so a swapped channel ID is invisible in configuration and in Discord. **If one server goes quiet, look here first.**

`GET /api/schedule/daily-update` reports `servers[]` with each channel's live state and last run; `GET /api/announcement/attendance` reports `today.servers[]` with per-server `posted` and `lastOutcome`, and a top-level `today.posted` that is true only when every server has today's message.

---

## 6. Recommended Next.js architecture

The frontend is **Next.js 16.3 / React 19 / App Router / Tailwind v4**. Next 16 renamed Middleware to **Proxy** (`proxy.ts`), `cookies()`/`headers()`/`params`/`searchParams` are **async**, and caching is opt-in via `use cache`.

**Call the admin API from the server, not the browser.** Reasons, in order of weight:

1. The backend's cookies are unusable cross-origin (§4b), so browser-side auth would mean putting the access token in JS-readable storage.
2. Tokens stay in httpOnly cookies that never reach client JS.
3. Refresh-and-retry lives in one server module instead of in every component.
4. No CORS preflight on the hot path; the browser only ever talks to its own origin.

```
frontend/
├── proxy.ts                      # optimistic redirect only (Next 16 name for middleware)
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx            # calls requireSession() — the real auth check
│   │   ├── page.tsx
│   │   ├── schedule/page.tsx
│   │   ├── reminders/page.tsx
│   │   └── reminders/[id]/page.tsx
│   └── api/
│       └── reminders/[id]/progress/route.ts   # thin same-origin proxy for client polling
├── lib/
│   ├── api/
│   │   ├── types.ts              # envelope + DTOs (§7)
│   │   ├── client.ts             # server-only fetch + refresh-and-retry
│   │   ├── errors.ts             # the five error shapes → one ApiError
│   │   └── endpoints/            # one file per backend module
│   ├── auth/session.ts           # cookie read/write + cache()-memoized DAL
│   └── dhaka-date.ts
└── actions/                      # 'use server' mutations
```

Two rules from the Next docs that shape this:

- **Proxy is not authorization.** `proxy.ts` does an _optimistic_ check (is a session cookie present?) to avoid a flash of the dashboard. The authoritative check is `requireSession()` in the layout and in every data-access function — the Data Access Layer pattern.
- **`fetch` is uncached by default in Next 16.** That is what you want for dashboard data. Reach for `use cache` + `cacheLife`/`cacheTag` only where staleness is acceptable (see §10), and wrap slow reads in `<Suspense>` so `loading.tsx` isn't blocked.

---

## 7. The integration layer (copy-paste starting point)

### 7.1 Types — `lib/api/types.ts`

```ts
export type ApiResponse<T> = {
  success: boolean;
  statusCode: number;
  message?: string;
  meta?: { page: number; limit: number; total: number };
  data: T;
};

// ── Auth ────────────────────────────────────────────────────────────────
export type TokenPair = { accessToken: string; refreshToken: string };

export type UserRole = 'ADMIN';
export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'BANNED';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminProfile = {
  id: string;
  userId: string;
  profilePhoto: string | null;
  bio: string | null;
  dateOfBirth: string | null;
  address: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminUserWithProfile = AdminUser & { profile: AdminProfile | null };

// ── Discord ─────────────────────────────────────────────────────────────
export type SyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  fetched: number;
  synced: number;
  failed: number;
  markedDeparted: number;
  guardTripped: boolean;
  lastError: string | null;
};

export type DiscordSyncStatus = {
  bot: {
    connected: boolean;
    tag: string | null;
    /** Every configured server's snowflake. Empty when the bot is offline. */
    guildIds: string[];
  };
  members: { total: number; active: number; departed: number };
  lastSync: SyncState;
  dailyUpdate: {
    ingestionEnabled: boolean;
    reason: string | null;
    channelId: string | null;
  };
  servers: Array<{
    guildId: string;
    label: string;
    reachable: boolean;
    unreachableReason: string | null;
    members: { total: number; active: number; departed: number } | null;
    lastSync: { ranAt: string; ok: boolean; error: string | null } | null;
    channels: {
      attendance?: { id: string; verified: boolean; error: string | null };
      dailyUpdate?: { id: string; verified: boolean; error: string | null };
      dailyUpdateReminder?: {
        id: string;
        verified: boolean;
        error: string | null;
      };
    };
  }>;
};

export type SyncTriggerResult = {
  accepted: true;
  guildIds: string[];
  startedAt: string;
};

// ── Schedule ────────────────────────────────────────────────────────────
export type ScheduleLastRun = {
  action: 'open' | 'lock' | 'reconcile';
  trigger: 'schedule' | 'reconcile' | 'manual';
  ranAt: string;
  ok: boolean;
  error: string | null;
};

export type ChannelSchedulePayload = {
  schedule: {
    openTime: string; // "HH:mm" — read-only, mirrors the announcement time
    openTimeSource: 'ANNOUNCEMENT'; // render the open-time field disabled
    closeTime: string; // "HH:mm"
    daysOfWeek: number[]; // 0 = Sunday … 6 = Saturday
    enabled: boolean;
    timezone: 'Asia/Dhaka'; // reported, never sent
    updatedAt: string;
    updatedBy: { id: string; name: string; email: string } | null;
  };
  scheduler: {
    processEnabled: boolean;
    running: boolean;
    nextOpenAt: string | null;
    nextLockAt: string | null;
    lastRun: ScheduleLastRun | null;
  };
  /** Top-level channel reports the first server — use `servers[]` for the full set. */
  channel: { id: string | null; isOpen: boolean };
  /** Live state per configured server — what the dashboard renders. */
  servers: Array<{
    guildId: string;
    label: string;
    channelId: string;
    isOpen: boolean | null; // null when the live read failed
    lastRun: ScheduleLastRun | null;
  }>;
};

export type ChannelToggleResult = {
  isOpen: boolean;
  /** Fan-out envelope. Always read `summary.failed` — partial success is 200. */
  summary: { total: number; succeeded: number; failed: number };
  servers: Array<{
    guildId: string;
    label: string;
    ok: boolean;
    value?: { channelId: string | null; isOpen: boolean; announced: boolean };
    error?: string;
    channelId: string | null;
  }>;
};

// ── Attendance announcement ─────────────────────────────────────────────
export type AnnouncementPlaceholder =
  | '{{date}}'
  | '{{close_time}}'
  | '{{daily_update_channel_id}}'
  | '{{attendance_form_link}}'
  | '{{termination_day}}';

export type ResolvedMentions = {
  roleIds: string[];
  userIds: string[];
  /** Entries that no longer resolve, as `role:<id>` / `user:<handle>`. */
  unresolved: string[];
};

export type AnnouncementAttemptStatus = 'SENDING' | 'POSTED' | 'FAILED';

export type AnnouncementAttempt = {
  attempt: number;
  status: AnnouncementAttemptStatus;
  trigger: 'SCHEDULED' | 'MANUAL';
  discordMessageId: string | null;
  unresolvedTargets: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnnouncementDispatchResult =
  | {
      status: 'posted';
      announcementDate: string;
      attempt: number;
      messageId: string;
      unresolvedTargets: string[];
    }
  | {
      status: 'already-sent';
      announcementDate: string;
      attempt: number;
      postedAt: string;
    }
  | { status: 'disabled' }
  | {
      status: 'failed';
      announcementDate: string;
      error: string;
      missingPermission: boolean;
      notConnected: boolean;
    };

export type AnnouncementPayload = {
  template: {
    body: string; // placeholders NOT expanded
    terminationDays: number;
    mentionEveryone: boolean;
    mentionRoleIds: string[];
    mentionUsernames: string[];
    updatedAt: string;
    updatedBy: { id: string; name: string; email: string } | null;
  };
  schedule: {
    announceTime: string; // "HH:mm"
    daysOfWeek: number[]; // 0 = Sunday … 6 = Saturday
    enabled: boolean;
    timezone: 'Asia/Dhaka'; // reported, never sent
  };
  preview: {
    content: string; // exactly what would be posted right now
    length: number;
    limit: 2000;
    closeTime: string; // read from the #daily-update schedule
    mentions: ResolvedMentions;
  };
  supportedPlaceholders: AnnouncementPlaceholder[];
  scheduler: {
    processEnabled: boolean;
    running: boolean;
    nextRunAt: string | null;
    lastOutcome: {
      ranAt: string;
      trigger: 'SCHEDULED' | 'MANUAL';
      result: AnnouncementDispatchResult;
    } | null;
  };
  channel: { id: string | null };
  today: {
    date: string; // YYYY-MM-DD, Dhaka
    posted: boolean;
    attempts: AnnouncementAttempt[];
  };
};

export type AnnouncementPreview = {
  content: string;
  length: number;
  limit: 2000;
  withinLimit: boolean;
  closeTime: string;
  mentions: ResolvedMentions;
  supportedPlaceholders: AnnouncementPlaceholder[];
};

export type AnnouncementSendResult = {
  announcementDate: string;
  summary: {
    total: number;
    posted: number;
    failed: number;
    alreadySent: number;
  };
  servers: Array<{
    guildId: string;
    label: string;
    status: 'posted' | 'already-sent' | 'disabled' | 'failed';
    attempt?: number;
    messageId?: string;
    unresolvedTargets?: string[];
    error?: string;
  }>;
  // The submission window, opened by this send in the servers it posted to.
  channel: {
    opened: string[]; // guild IDs whose #daily-update this send opened
    alreadyOpen: string[]; // guild IDs already open — not re-edited
    failed: Array<{ guildId: string; label: string; error: string | null }>;
    locksAt: string | null; // "HH:mm", or null when no lock job is registered
  };
};

// ── Reminders ───────────────────────────────────────────────────────────
export type ReminderStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export type ReminderDeliveryStatus =
  'PENDING' | 'DELIVERED' | 'DM_CLOSED' | 'FAILED';

export type ReminderCriterion = 'MISSING_UPDATE' | 'MISSING_BOTH';

export type ReminderTarget = {
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  /** The member record's configured server — the row's per-server audit lane. */
  guildId: string;
  serverLabel: string;
};

/** Echo of a date-mode reminder period. */
export type ReminderDatePeriodEcho = {
  mode: 'date';
  date: string;
  daysInRange: number;
};

/** Echo of a range-mode reminder period. */
export type ReminderRangePeriodEcho = {
  mode: 'range';
  from: string;
  to: string;
  /** Weekday filter that was applied, or null when every day counted. */
  daysOfWeek: number[] | null;
  daysInRange: number;
};

export type ReminderTargetsPayload = (
  | ReminderDatePeriodEcho
  | ReminderRangePeriodEcho
) & {
  criterion: ReminderCriterion;
  minMissedDays: number;
  /**
   * Recipient rows — one per member record. Lower than `uniqueRecipients` when
   * a person is in several servers.
   */
  targetCount: number;
  /** Distinct accounts that will actually be DMed. */
  uniqueRecipients: number;
  targets: ReminderTarget[];
};

export type ReminderQueued = {
  id: string;
} & (
  | ReminderDatePeriodEcho
  | ReminderRangePeriodEcho
) & {
    criterion: ReminderCriterion;
    minMissedDays: number;
    targetCount: number;
    queuedJobs: number;
    status: ReminderStatus;
  };

export type ReminderProgress = {
  id: string;
  reminderStartDate: string;
  reminderEndDate: string;
  criterion: ReminderCriterion;
  minMissedDays: number;
  daysOfWeek: number[] | null;
  message: string;
  status: ReminderStatus;
  targetCount: number;
  delivered: number;
  dmClosed: number;
  failed: number;
  outstanding: number; // still PENDING
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type ReminderLogRow = {
  id: string;
  reminderStartDate: string;
  reminderEndDate: string;
  criterion: ReminderCriterion;
  minMissedDays: number;
  daysOfWeek: number[];
  message: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  status: ReminderStatus;
  createdById: string | null;
  createdBy: { id: string; name: string; email: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type ReminderRecipientRow = {
  id: string;
  memberId: string;
  status: ReminderDeliveryStatus;
  errorMessage: string | null;
  sentAt: string | null;
  member: {
    discordUserId: string;
    discordUsername: string;
    displayName: string | null;
  };
};

export type ReminderQueueStatus = {
  workerRunning: boolean;
  workerEnabled: boolean;
  redisConnected: boolean;
  redisError: string | null;
  dmPerSecond: number;
  queueDepth: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  } | null;
  lastFallback: {
    reminderId: string;
    ranAt: string;
    ok: boolean;
    mentioned: number;
    error: string | null;
    missingPermission: boolean;
  } | null;
};

// ── Attendance (public) ─────────────────────────────────────────────────
export type VerifiedMember = {
  id: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type VerifyUserPayload = {
  verified: boolean;
  alreadySubmitted: boolean;
  attendanceDate: string;
  member: VerifiedMember | null;
};

export type VerifyEmailPayload = {
  verified: boolean;
  attendanceDate: string;
  emailVerificationRequired: boolean;
};

export type SubmitAttendancePayload = {
  attendanceDate: string;
  submittedAt: string;
  member: VerifiedMember;
};

export type AttendanceWindowPayload = {
  isOpen: boolean;
  date: string;
  openTime: string;
  closeTime: string;
  daysOfWeek: number[];
  enabled: boolean;
  timezone: string;
  nextOpenAt: string | null;
  closesAt: string | null;
  /** True = the email on submit must be one on the enrolled student list. */
  emailVerificationRequired: boolean;
};

// ── Daily Status ──────────────────────────────────────────────────────────
export type DailyStatus =
  'COMPLETE' | 'MISSING_UPDATE' | 'MISSING_ATTENDANCE' | 'MISSING_BOTH';

export type DailyStatusCounts = {
  date: string;
  totalMembers: number;
  attendanceSubmitted: number;
  dailyUpdateSubmitted: number;
  bothComplete: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type DailyStatusRow = {
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  hasAttendance: boolean;
  hasDailyUpdate: boolean;
  status: DailyStatus;
  attendanceSubmittedAt: string | null;
};

export type MemberDailyStatus = DailyStatusRow & {
  messages: Array<{
    id: string;
    content: string;
    postedAt: string;
  }>;
};
```

### 7.2 Error normalization — `lib/api/errors.ts`

```ts
export type FieldIssue = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: FieldIssue[] = [],
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Zod rejected the payload — render `issues` against your own field labels. */
  get isValidation() {
    return this.status === 400 && this.issues.length > 0;
  }

  /** Access token is expired or malformed. Note the backend answers 500 for this. */
  get isAuthExpired() {
    return (
      this.status === 401 ||
      (this.status === 500 && EXPIRED_JWT.has(this.message))
    );
  }

  /** Field-keyed map for react-hook-form / useActionState. Keys are lowercased. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(
      this.issues.map((i) => [lowerFirst(i.path), i.message]),
    );
  }
}

const EXPIRED_JWT = new Set([
  'jwt expired',
  'invalid signature',
  'jwt malformed',
  'invalid token',
]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Collapses all five backend error shapes (§3) into one ApiError. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }

  const issues: FieldIssue[] = Array.isArray(body?.errorDetails?.issues)
    ? body.errorDetails.issues
    : [];

  // `message` on the Zod branch is the joined string; the per-field text is in
  // issues. On the P2002/P2025 branches the useful text is in `errorMessage`.
  const message =
    (issues.length ? issues.map((i) => i.message).join(', ') : null) ??
    body?.errorMessage ??
    body?.message ??
    `Request failed with status ${res.status}`;

  return new ApiError(res.status, message, issues, body);
}
```

### 7.3 Session cookies — `lib/auth/session.ts`

```ts
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { TokenPair } from '@/lib/api/types';

export const ACCESS_COOKIE = 'dm_access';
export const REFRESH_COOKIE = 'dm_refresh';

// The backend's refresh-token DB row expires in 7 days regardless of the JWT's
// own exp (§4e), so the cookie must not outlive it.
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function writeSession({ accessToken, refreshToken }: TokenPair) {
  const jar = await cookies(); // async in Next 16
  const secure = process.env.NODE_ENV === 'production';

  jar.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SEVEN_DAYS,
  });
  jar.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SEVEN_DAYS,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function readSession() {
  const jar = await cookies();
  return {
    accessToken: jar.get(ACCESS_COOKIE)?.value ?? null,
    refreshToken: jar.get(REFRESH_COOKIE)?.value ?? null,
  };
}

/**
 * The authoritative auth check — the Data Access Layer entry point.
 * `cache()` memoizes it for one render pass, so calling it in the layout and in
 * three data functions still hits the cookie jar once.
 */
export const requireSession = cache(async () => {
  const session = await readSession();
  if (!session.accessToken) redirect('/login');
  return session as { accessToken: string; refreshToken: string | null };
});
```

### 7.4 The API client — `lib/api/client.ts`

```ts
import 'server-only';
import { redirect } from 'next/navigation';
import { ApiError, toApiError } from '@/lib/api/errors';
import type { ApiResponse } from '@/lib/api/types';
import {
  clearSession,
  readSession,
  requireSession,
  writeSession,
} from '@/lib/auth/session';

const BASE = process.env.API_BASE_URL!;

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip auth entirely (login, refresh, the public attendance routes). */
  anonymous?: boolean;
};

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '')
      url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Returns the full envelope, so paginated callers can read `meta`. */
export async function apiRequest<T>(
  path: string,
  { body, query, anonymous, headers, ...init }: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const send = async (accessToken: string | null) => {
    const res = await fetch(buildUrl(path, query), {
      ...init,
      // Next 16: fetch is uncached by default. Dashboard reads want that.
      cache: init.cache ?? 'no-store',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // ⚠️ Bare token — NO "Bearer " prefix (§4a).
        ...(accessToken ? { Authorization: accessToken } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  let accessToken: string | null = null;
  if (!anonymous) accessToken = (await requireSession()).accessToken;

  let res = await send(accessToken);

  if (!res.ok && !anonymous) {
    const error = await toApiError(res);
    // An expired access token arrives as HTTP 500 "jwt expired" (§3g).
    if (error.isAuthExpired) {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        await clearSession();
        redirect('/login');
      }
      res = await send(refreshed.accessToken);
    } else {
      throw error;
    }
  }

  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ApiResponse<T>;
}

/** Convenience wrapper for the common case where only `data` matters. */
export async function api<T>(
  path: string,
  options?: RequestOptions,
): Promise<T> {
  return (await apiRequest<T>(path, options)).data;
}

// ── Refresh, single-flight ───────────────────────────────────────────────
// Rotation deletes the old row (§4d), so two concurrent refreshes log the user
// out. One in-flight promise per server instance is enough to prevent that
// within a request burst.
let inFlight: Promise<{
  accessToken: string;
  refreshToken: string;
} | null> | null = null;

function refreshTokens() {
  inFlight ??= (async () => {
    try {
      const { refreshToken } = await readSession();
      if (!refreshToken) return null;

      const res = await fetch(`${BASE}/auth/refresh-token`, {
        method: 'POST',
        // ⚠️ The endpoint reads req.cookies.refreshToken, not the body (§4c).
        headers: { Cookie: `refreshToken=${refreshToken}` },
        cache: 'no-store',
      });
      if (!res.ok) return null;

      const json = (await res.json()) as ApiResponse<{
        accessToken: string;
        refreshToken: string;
      }>;
      await writeSession(json.data);
      return json.data;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export { ApiError };
```

> **Cookie writes from Server Components are not allowed.** `writeSession()` may only be called from a Server Action or a Route Handler. If a token expires during a page render, `refreshTokens()` will throw on `cookies().set` — catch it and `redirect('/login')`, or (cleaner) refresh proactively in `proxy.ts`/a Route Handler. Reads via `cookies().get` are fine everywhere.

### 7.5 Optimistic redirect — `proxy.ts`

```ts
// frontend/proxy.ts — Next 16 renamed Middleware to Proxy. Same semantics.
import { NextResponse, type NextRequest } from 'next/server';

const ACCESS_COOKIE = 'dm_access';

export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  // Optimistic only — presence of a cookie, never a token verification.
  // The real check is requireSession() in the dashboard layout and in the DAL.
  if (!hasSession && pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
};
```

---

## 8. Endpoint reference

Legend: 🔓 public (no auth) · 🔐 `auth(ADMIN)` — bare access token in `Authorization`.

---

### 8.1 Auth — `/api/auth`

#### 🔓 `POST /api/auth/login`

**Body**

| Field      | Type   | Rules                 |
| ---------- | ------ | --------------------- |
| `email`    | string | must be a valid email |
| `password` | string | non-empty             |

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "User logged in successfully",
  "data": { "accessToken": "eyJ…", "refreshToken": "eyJ…" },
}
```

Also sets `accessToken`/`refreshToken` cookies — **ignore them** (§4b) and use the body.

**Failure modes**

| Status | Cause               | Body `message`                                                |
| ------ | ------------------- | ------------------------------------------------------------- |
| 400    | Zod                 | title-cased field messages                                    |
| 401    | wrong password      | `Invalid Credentials`                                         |
| 403    | `status !== ACTIVE` | `Your account has been suspended. Please contact support.`    |
| 403    | `role !== ADMIN`    | `Access denied. Only administrators are permitted to log in.` |
| 404    | unknown email       | `Record not found`                                            |

Collapse 401 and 404 into one generic message in the UI — don't confirm which emails exist.

**Next.js — Server Action**

```ts
// actions/auth.ts
'use server';
import { redirect } from 'next/navigation';
import { apiRequest, ApiError } from '@/lib/api/client';
import { writeSession, clearSession } from '@/lib/auth/session';
import type { TokenPair } from '@/lib/api/types';

export type LoginState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  try {
    const { data } = await apiRequest<TokenPair>('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { email, password },
    });
    await writeSession(data);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.isValidation) return { fieldErrors: error.fieldErrors() };
      if (error.status === 401 || error.status === 404) {
        return { error: 'Incorrect email or password.' };
      }
      return { error: error.message }; // 403 messages are written for humans
    }
    return { error: 'Could not reach the server. Try again.' };
  }

  redirect('/dashboard'); // must be outside try — redirect() throws by design
}

export async function logout() {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
  } catch {
    /* best effort */
  }
  await clearSession();
  redirect('/login');
}
```

```tsx
// app/(auth)/login/page.tsx
'use client';
import { useActionState } from 'react';
import { login, type LoginState } from '@/actions/auth';

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  return (
    <form action={action}>
      <input
        name="email"
        type="email"
        required
        aria-invalid={!!state.fieldErrors?.email}
      />
      {state.fieldErrors?.email && (
        <p role="alert">{state.fieldErrors.email}</p>
      )}
      <input name="password" type="password" required />
      {state.error && <p role="alert">{state.error}</p>}
      <button disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
```

---

#### 🔓 `POST /api/auth/refresh-token`

**Input:** the `refreshToken` **cookie** (`Cookie: refreshToken=…`). No body, no query.

**200** → `data: { accessToken, refreshToken }` — the refresh token is **rotated**; the old one is deleted and is no longer valid.

| Status | Cause                                                           |
| ------ | --------------------------------------------------------------- |
| 401    | missing / unknown / DB-expired token, or `jwt.verify` failure   |
| 403    | user is no longer `ACTIVE` (all their refresh rows are deleted) |
| 404    | the user row is gone                                            |

Handled centrally by `refreshTokens()` in §7.4 — pages never call this directly.

---

#### 🔓 `POST /api/auth/logout`

Reads the `refreshToken` cookie and deletes the DB row. Always **200** with `data: null`, even without a cookie. Clear your own Next cookies afterwards regardless of the result.

---

### 8.2 Users — `/api/users`

#### 🔐 `GET /api/users/me`

No parameters. Returns the logged-in admin, password omitted, **profile not included**.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "User profile retrieved successfully",
  "data": {
    "id": "…",
    "name": "Rakib",
    "email": "admin@example.com",
    "phone": null,
    "role": "ADMIN",
    "status": "ACTIVE",
    "lastActiveAt": "2026-08-17T09:12:44.000Z",
    "createdAt": "…",
    "updatedAt": "…",
  },
}
```

Every authenticated request bumps `lastActiveAt`, so this value moves constantly — don't cache it.

```ts
// lib/api/endpoints/user.ts
import 'server-only';
import { cache } from 'react';
import { api } from '@/lib/api/client';
import type { AdminUser } from '@/lib/api/types';

/** Memoized per render pass, so the layout and the header share one call. */
export const getCurrentAdmin = cache(() => api<AdminUser>('/users/me'));
```

#### 🔐 `PUT /api/users/my-profile`

**Body** — all fields optional, but Zod strips unknown keys and an empty object is accepted (it becomes a no-op write).

| Field          | Type   | Rules       |
| -------------- | ------ | ----------- |
| `name`         | string | 2–100 chars |
| `email`        | string | valid email |
| `profilePhoto` | string | valid URL   |
| `bio`          | string | ≤ 500 chars |

`name`/`email` update `users`; `profilePhoto`/`bio` update the nested `profiles` row.

**200** → the updated user **with** `profile` included.

| Status | Cause                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | Zod                                                                                                                                  |
| 404    | the admin has no `profiles` row — the nested `update` raises P2025. The seed creates one; an admin inserted by hand may not have it. |
| 409    | `email` already belongs to another user (`Duplicate Error`, message in `errorMessage`)                                               |

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { AdminUserWithProfile } from '@/lib/api/types';

export async function updateProfile(_prev: unknown, formData: FormData) {
  const payload = Object.fromEntries(
    ['name', 'email', 'profilePhoto', 'bio']
      .map((k) => [k, formData.get(k)])
      .filter(([, v]) => typeof v === 'string' && v !== ''),
  );

  try {
    await api<AdminUserWithProfile>('/users/my-profile', {
      method: 'PUT',
      body: payload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return error.isValidation
        ? { fieldErrors: error.fieldErrors() }
        : { error: error.message };
    }
    throw error;
  }

  revalidatePath('/dashboard/settings');
  return { success: true };
}
```

---

### 8.3 Discord — `/api/discord`

#### 🔐 `GET /api/discord/servers`

No parameters. Returns the configured servers and whether the bot currently reaches each.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Configured Discord servers retrieved successfully",
  "data": [
    {
      "guildId": "146…",
      "label": "Batch A",
      "name": "Programming Hero B12",
      "reachable": true,
      "unreachableReason": null,
    },
    {
      "guildId": "246…",
      "label": "Batch B",
      "name": null,
      "reachable": false,
      "unreachableReason": "The guild could not be fetched: Missing Access",
    },
  ],
}
```

Use this as the source of truth for any server filter — never hard-code IDs. **A single-server deployment returns one entry**, not zero — treat one as the normal case.

#### 🔐 `GET /api/discord/sync/status`

No parameters. Reports bot health, member counts, the last sync summary, and the daily-update ingestion state **per configured server**.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Discord sync status retrieved successfully",
  "data": {
    "bot": {
      "connected": true,
      "tag": "DailyBot#1234",
      "guildIds": ["146…", "246…"],
    },
    "members": { "total": 5201, "active": 5187, "departed": 14 },
    "lastSync": {
      "running": false,
      "startedAt": "…",
      "finishedAt": "…",
      "durationMs": 41290,
      "fetched": 5187,
      "synced": 5187,
      "failed": 0,
      "markedDeparted": 3,
      "guardTripped": false,
      "lastError": null,
    },
    "dailyUpdate": {
      "ingestionEnabled": true,
      "reason": null,
      "channelId": "1234567890123456789",
    },
    "servers": [
      {
        "guildId": "146…",
        "label": "Batch A",
        "reachable": true,
        "unreachableReason": null,
        "members": { "total": 3000, "active": 2998, "departed": 2 },
        "lastSync": { "ranAt": "…", "ok": true, "error": null },
        "channels": {
          "attendance": {
            "id": "111…",
            "verified": true,
            "error": null,
          },
          "dailyUpdate": {
            "id": "222…",
            "verified": true,
            "error": null,
          },
          "dailyUpdateReminder": {
            "id": "333…",
            "verified": true,
            "error": null,
          },
        },
      },
      {
        "guildId": "246…",
        "label": "Batch B",
        "reachable": false,
        "unreachableReason": "The guild could not be fetched: Missing Access",
        "members": null,
        "lastSync": null,
        "channels": {
          "dailyUpdate": {
            "id": "444…",
            "verified": false,
            "error": "daily-update channel 444… belongs to guild 999…, not 246…",
          },
        },
      },
    ],
  },
}
```

**Surface these things prominently — they are otherwise invisible failures:**

- `dailyUpdate.ingestionEnabled === false` → the bot fell back to a login without the Message Content intent. Every message is arriving empty, so **no daily updates are being recorded** and the dashboard will show everyone as `MISSING_UPDATE`. Show `reason` and link to the Developer Portal fix.
- `lastSync.guardTripped === true` → the departure guard skipped a reconcile because a member fetch came back suspiciously small. The directory is stale but intact; this is the guard working, not a bug. Warn, don't alarm.
- `bot.connected === false` → sync, ingestion, the scheduler's channel edits, and reminder DMs are all down. The REST API keeps serving.
- **`servers[i].channels[*].verified === false`** → a channel ID is misconfigured for that server. The names match across servers, so a swapped ID is invisible in Discord. The `error` field names what is wrong; **if one server goes quiet, look here first.**
- `servers[i].reachable === false` → bot cannot see that guild; the rest of that server's data is `null`. Sync, ingestion, scheduler edits and reminder DMs targeting it all silently fail.

#### 🔐 `POST /api/discord/sync`

**Body** — empty or `{ "guildId": "…" }`. An empty body (or omitted `guildId`) syncs every configured server, which is the ordinary case. A named `guildId` narrows the sync to one server — useful when a single server's directory needs repairing without paying for a full multi-thousand-member fetch of the others. The ID must be a 17–20 digit Discord snowflake, and it must be one of the configured servers — an unknown ID is a 400 naming it.

Fires the sync **without awaiting it** — a real sync takes tens of seconds.

**202**

```jsonc
{
  "success": true,
  "statusCode": 202,
  "message": "Member sync started",
  "data": {
    "accepted": true,
    "guildIds": ["146…", "246…"],
    "startedAt": "2026-08-17T09:20:00.000Z",
  },
}
```

| Status | Cause                                                                                  |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | `guildId` is not a configured server — message names it                                |
| 409    | a sync is already running                                                              |
| 503    | bot not connected, or every targeted guild could not be fetched                        |

Because the response returns before the work does, poll `GET /sync/status` until `lastSync.running` flips to `false`:

```ts
'use server';
import { revalidateTag } from 'next/cache';
import { api } from '@/lib/api/client';
import type { SyncTriggerResult } from '@/lib/api/types';

export async function triggerMemberSync(guildId?: string) {
  const result = await api<SyncTriggerResult>('/discord/sync', {
    method: 'POST',
    body: guildId ? { guildId } : {},
  });
  revalidateTag('discord-status');
  return result; // the client then polls until lastSync.running === false
}
```

---

### 8.4 Schedule — `/api/schedule`

All routes 🔐. This governs when ~5,000 students may post in `#daily-update`.

#### 🔐 `GET /api/schedule/daily-update`

No parameters. The row is created lazily with defaults (19:00 / 23:59 / all seven days / enabled) on first read, so this never 404s.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Channel schedule retrieved successfully",
  "data": {
    "schedule": {
      "openTime": "19:00",
      "openTimeSource": "ANNOUNCEMENT",
      "closeTime": "23:59",
      "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
      "enabled": true,
      "timezone": "Asia/Dhaka",
      "updatedAt": "…",
      "updatedBy": { "id": "…", "name": "Rakib", "email": "…" },
    },
    "scheduler": {
      "processEnabled": true,
      "running": true,
      "nextOpenAt": "2026-08-17T12:00:00.000Z",
      "nextLockAt": "2026-08-17T17:59:00.000Z",
      "lastRun": {
        "action": "open",
        "trigger": "schedule",
        "ranAt": "…",
        "ok": true,
        "error": null,
      },
    },
    "channel": { "id": "1234567890123456789", "isOpen": true },
    "servers": [
      {
        "guildId": "146…",
        "label": "Batch A",
        "channelId": "222…",
        "isOpen": true,
        "lastRun": { "action": "open", "trigger": "schedule", "ranAt": "…", "ok": true, "error": null },
      },
      {
        "guildId": "246…",
        "label": "Batch B",
        "channelId": "444…",
        "isOpen": false,
        "lastRun": { "action": "lock", "trigger": "schedule", "ranAt": "…", "ok": false, "error": "Missing Permissions" },
      },
    ],
  },
}
```

- **`openTime` is read-only here and `openTimeSource` is always `"ANNOUNCEMENT"`.** The channel opens at the moment the attendance announcement is posted, so the open time mirrors `announceTime` from `GET /api/announcement/attendance`. Render it as a disabled field with a link to the announcement form; sending it back in a `PATCH` is a 400.
- `channel.id` reports the **first** configured channel; the per-server channel ID lives under `servers[i].channelId`. The top-level `channel.isOpen` is the same live read as `servers[0].isOpen` in a single-server deployment.
- **`servers[i].isOpen` is read live from Discord on every request** (an admin can flip the overwrite by hand), so this endpoint always costs a Discord API call per configured server — never cache it.
- **`scheduler.lastRun.error` and `servers[i].lastRun.error` are where a missing `Manage Roles` permission shows up.** Per-server last runs surface partial outages that the top-level `lastRun` collapses; the channel that stopped opening is the entry with `ok: false`. `DiscordAPIError[50013]` means the bot lacks the permission on that channel.
- `scheduler.processEnabled === false` means `SCHEDULER_ENABLED=false` on this process — the timed jobs are off, but the manual open/lock endpoints still work.
- `nextOpenAt`/`nextLockAt` are `null` when no task is registered (disabled schedule, or a process that isn't scheduling).

#### 🔐 `PATCH /api/schedule/daily-update`

**Body** — a patch; every field optional, but **an empty object is rejected (400)**.

| Field        | Type     | Rules                                           |
| ------------ | -------- | ----------------------------------------------- |
| `closeTime`  | string   | 24-hour `HH:mm`, `00:00`–`23:59`                |
| `daysOfWeek` | number[] | ≥ 1 entry, each 0–6 (0 = Sunday), no duplicates |
| `enabled`    | boolean  | —                                               |

Do **not** send `timezone` — Zod strips it silently; the zone is fixed.

**`openTime` is refused here (400), not ignored.** It mirrors the announcement time, so it changes at `PATCH /api/announcement/attendance` and this window moves with it. The refusal is deliberate: silently dropping the field would let a form report a successful save while the open time never moved.

**Cross-field rule (a 400 from the service, not from Zod):** `closeTime` must be strictly greater than the stored `openTime`. Sending `{ "closeTime": "02:00" }` against a stored `openTime` of `19:00` is a 400 with a long explanatory message. Mirror this check in the form before submitting, using the currently-loaded schedule as the merge base — and note that lowering `closeTime` past the announcement time is refused, so the announcement has to move first.

**200** → the same payload shape as `GET`, already reflecting the change (the scheduler is reloaded in-process; no restart needed).

```ts
// actions/schedule.ts
'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { ChannelSchedulePayload } from '@/lib/api/types';

export async function updateSchedule(input: {
  // no openTime — it follows the announcement time
  closeTime?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
}) {
  try {
    const data = await api<ChannelSchedulePayload>('/schedule/daily-update', {
      method: 'PATCH',
      body: input,
    });
    revalidatePath('/dashboard/schedule');
    return { data };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}
```

Build the editor as a time picker + weekday checkboxes. **Never expose a cron field** — the expression is derived at registration and never stored.

#### 🔐 `POST /api/schedule/daily-update/open` and `.../lock`

**Body** — `{ guildIds?: string[] }`. Omitted or empty means **every** configured server, which is the ordinary case. `guildIds` narrows the action — useful for recovering one server whose permission was fixed after the others already moved. Each ID must be a 17–20 digit Discord snowflake and a configured server; an unknown ID is a 400 naming it.

Forces the channel state **now** and posts an announcement embed to each targeted channel (`announce: true`). The stored schedule is untouched, so the next scheduled transition still fires.

**200** → `data: { isOpen, summary: { total, succeeded, failed }, servers: [...] }`. The endpoint **fans out across every targeted server** — partial success is `200`, not an error. Each entry in `servers[]` carries `ok`, `value`, and on failure `error` and `channelId`. Always read `data.summary.failed`; only a total failure returns an error status.

| Status | Cause                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `guildIds` contains an unconfigured server — message names it                                                                  |
| 403    | the bot lacks `Manage Roles` on one or more channels — the success carries the per-server error; only total failure is 403    |
| 503    | the bot is not connected, or the permission edit failed for every targeted server                                              |

These are **outward-facing and immediately visible to thousands of students** (they post an embed). Put them behind a confirmation dialog.

---

### 8.5 Reminders — `/api/reminders`

All routes 🔐. `POST /send` DMs thousands of people and **cannot be undone**.

> **Route order matters on the backend**: `/targets` and `/status` are declared before `/:id`. Don't invent an id-shaped path that collides with them.

#### The period: a date OR a from/to range

Every reminder endpoint accepts **either** a single `date` **or** a `from`/`to` pair. The two are mutually exclusive — sending both, or only one half of the pair, is a 400 naming the conflict. Every response states which mode produced it in a `mode` field and echoes the parameters it resolved.

| Parameter          | Applies to      | Meaning                                                                                                                      |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `date=YYYY-MM-DD`  | date mode       | One Dhaka day. **Cannot be in the future** — there is nothing to be missing yet, so every member would be a target.           |
| `from=` + `to=`    | range mode      | An inclusive span of Dhaka days. **Max 92 days** — a blast-radius control.                                                   |
| `daysOfWeek=0,1,2` | range mode only | Which weekdays inside the span count. `0` is Sunday, the same numbering the channel schedule uses. Omitted counts every day. |

> ⚠️ **`daysOfWeek` is an assertion, not a record.** It is the admin stating which days should count. The system does **not** store when `#daily-update` was actually open on a past day — no such history exists — so nothing verifies the claim. The response echoes `daysOfWeek` and the resulting `daysInRange` precisely so the figure always travels with its denominator.

A `minMissedDays` higher than the number of counted days is a 400 — it could never be met, and a request that always finds nobody is better refused than run.

#### Reminder criteria

| Parameter       | Default          | Meaning                                                                                                  |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `criterion`     | `MISSING_UPDATE` | `MISSING_UPDATE` = no daily update that day. `MISSING_BOTH` = neither attendance nor an update that day. |
| `minMissedDays` | `1`              | How many counted days the person must have failed to be targeted.                                        |

**The default is deliberate.** `MISSING_UPDATE` with a single `date` is exactly what a broadcast meant before ranges existed, so nothing about your existing send changes. Making `MISSING_BOTH` universal would silently stop reminding a student who fills the attendance form and never posts an update — and the daily-update channel is what this feature exists to drive.

#### 🔐 `GET /api/reminders/targets`

The dry run. Sends nothing.

**Date mode:**

| Query  | Type   | Rules                                                 |
| ------ | ------ | ----------------------------------------------------- |
| `date` | string | **required**, `YYYY-MM-DD`, not in the future         |

**Range mode:**

| Query         | Type   | Rules                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------- |
| `from`        | string | required, `YYYY-MM-DD`, ≤ today                                        |
| `to`          | string | required, `YYYY-MM-DD`, ≤ today, ≥ `from`                              |
| `daysOfWeek`  | string | optional, comma-separated `0..6`                                       |

**Always allowed (both modes):**

| Query         | Type   | Rules                                                                                  |
| ------------- | ------ | -------------------------------------------------------------------------------------- |
| `criterion`   | enum   | default `MISSING_UPDATE`                                                               |
| `minMissedDays` | number | default `1`, integer ≥ 1                                                                |
| `guildIds`    | string | optional, comma-separated Discord snowflakes — restrict the preview to listed servers. Omitted means every configured server. Each ID must be a configured server; an unknown ID is a 400 naming it. |

**200**

```jsonc
// date mode
{
  "data": {
    "mode": "date",
    "date": "2026-08-16",
    "daysInRange": 1,
    "criterion": "MISSING_UPDATE",
    "minMissedDays": 1,
    "targetCount": 412,
    "uniqueRecipients": 410,
    "targets": [
      {
        "memberId": "…",
        "discordUserId": "…",
        "discordUsername": "rakib_",
        "displayName": "Rakib",
        "guildId": "146…",
        "serverLabel": "Batch A",
      },
    ],
  }
}

// range mode
{
  "data": {
    "mode": "range",
    "from": "2026-08-15",
    "to": "2026-08-17",
    "daysOfWeek": null,
    "daysInRange": 3,
    "criterion": "MISSING_BOTH",
    "minMissedDays": 2,
    "targetCount": 87,
    "uniqueRecipients": 87,
    "targets": [ … ],
  }
}
```

`targetCount` counts **recipient rows** (one per member record, so a person in two servers appears twice — that is the per-server audit). `uniqueRecipients` counts **people** who will actually be DMed (lower when the same account is in several servers). The gap is not duplicate sends.

The list is **not paginated** — for a 5,000-member guild with a bad week this can be thousands of rows. Render it virtualized, or show `targetCount` plus a preview slice.

The target definition is the exact same query `POST /send` uses, so the preview cannot disagree with the send.

#### 🔐 `POST /api/reminders/send`

**Body** — a patch-like body; every period/criteria field optional except that **one of `date` or (`from` AND `to`) must be present**.

| Field           | Type     | Rules                                                                                  |
| --------------- | -------- | -------------------------------------------------------------------------------------- |
| `date`          | string   | one of `date` OR (`from` AND `to`); `YYYY-MM-DD`, not in the future                    |
| `from`          | string   | range start, inclusive, `YYYY-MM-DD`, ≤ today                                          |
| `to`            | string   | range end, inclusive, `YYYY-MM-DD`, ≤ today, ≥ `from`, ≤ 92 days after `from`           |
| `daysOfWeek`    | number[] | optional, range mode only, each 0–6 (0 = Sunday), no duplicates                        |
| `criterion`     | enum     | optional, default `MISSING_UPDATE`                                                     |
| `minMissedDays` | number   | optional, default `1`, integer ≥ 1                                                     |
| `message`       | string   | trimmed, 1–**1970** characters                                                         |
| `guildIds`      | string[] | optional, restrict to listed configured servers. Unknown ID is a 400 naming it.         |

The 1970 cap = Discord's 2000-character limit minus the fixed heading `⚠️ **Daily Update Reminder**` the DM is wrapped in. Enforce it in the textarea with a live counter so the admin never discovers it at submit time.

**202**

```jsonc
// date mode
{
  "data": {
    "id": "…",
    "mode": "date",
    "date": "2026-08-16",
    "daysInRange": 1,
    "criterion": "MISSING_UPDATE",
    "minMissedDays": 1,
    "targetCount": 412,
    "queuedJobs": 412,
    "status": "PENDING",
  }
}

// range mode
{
  "data": {
    "id": "…",
    "mode": "range",
    "from": "2026-08-15",
    "to": "2026-08-17",
    "daysOfWeek": null,
    "daysInRange": 3,
    "criterion": "MISSING_BOTH",
    "minMissedDays": 2,
    "targetCount": 87,
    "queuedJobs": 87,
    "status": "PENDING",
  }
}
```

**Nothing has been delivered when this returns.** Delivery is paced at `REMINDER_DM_PER_SECOND` (default 2/sec) — ~5,000 members is ~40 minutes. That pacing is deliberate: bursting DMs gets the bot banned, and the bot shares a process with member sync and the attendance form's membership check.

| Status | Cause                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | Zod, or **nobody meets the criteria** — "There is nobody to remind."                                                                                                            |
| 409    | a broadcast covering a day that overlaps with the requested one is already `PENDING`/`PROCESSING` — the message names the existing broadcast id and its period                |
| 503    | Redis unreachable, or the queue refused the jobs (the broadcast is auto-cancelled so the day isn't left blocked)                                                               |

**One broadcast at a time is now an OVERLAP check.** Two periods sharing any day conflict — a single date inside a running range conflicts, two ranges sharing one day conflict. The guard ignores `criterion`, `minMissedDays`, `daysOfWeek` and `guildIds`: the constraint it protects is the bot's single global DM budget, which does not care how a target list was computed. Use `POST /reminders/:id/cancel` to free a slot.

**Always run the `/targets` preview first and make the admin confirm the count.** Then redirect to the progress page:

```ts
// actions/reminders.ts
'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { ReminderQueued } from '@/lib/api/types';

export async function sendReminder(input: {
  date?: string;
  from?: string;
  to?: string;
  daysOfWeek?: number[];
  criterion?: 'MISSING_UPDATE' | 'MISSING_BOTH';
  minMissedDays?: number;
  message: string;
  guildIds?: string[];
}) {
  let queued: ReminderQueued;
  try {
    queued = await api<ReminderQueued>('/reminders/send', {
      method: 'POST',
      body: input,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message }; // 409/503 read well as-is
    throw error;
  }
  revalidatePath('/dashboard/reminders');
  redirect(`/dashboard/reminders/${queued.id}`);
}
```

#### 🔐 `GET /api/reminders` (history)

| Query   | Type   | Default | Rules                                           |
| ------- | ------ | ------- | ----------------------------------------------- |
| `page`  | number | 1       | integer ≥ 1                                     |
| `limit` | number | 50      | integer 1–200 (clamped again in the repository) |

**200** — newest first, with `meta`:

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Reminder broadcasts retrieved successfully",
  "meta": { "page": 1, "limit": 50, "total": 23 },
  "data": [
    {
      "id": "…",
      "reminderStartDate": "2026-08-16",
      "reminderEndDate": "2026-08-16",
      "criterion": "MISSING_UPDATE",
      "minMissedDays": 1,
      "daysOfWeek": [],
      "message": "…",
      "targetCount": 412,
      "sentCount": 388,
      "failedCount": 24,
      "status": "COMPLETED",
      "createdById": "…",
      "createdBy": { "id": "…", "name": "Rakib", "email": "…" },
      "startedAt": "…",
      "completedAt": "…",
      "createdAt": "…",
    },
  ],
}
```

`createdBy` is `null` when the admin account was deleted (the audit row survives on purpose).

> ⚠️ **`reminderDate` no longer exists.** Read the period from `reminderStartDate` / `reminderEndDate` — a single-date send stores the same date at both ends.

#### 🔐 `GET /api/reminders/:id` (live progress)

**200**

```jsonc
{
  "data": {
    "id": "…",
    "reminderStartDate": "2026-08-15",
    "reminderEndDate": "2026-08-17",
    "criterion": "MISSING_BOTH",
    "minMissedDays": 2,
    "daysOfWeek": null,
    "message": "…",
    "status": "PROCESSING",
    "targetCount": 87,
    "delivered": 41,
    "dmClosed": 3,
    "failed": 0,
    "outstanding": 43,
    "startedAt": "…",
    "completedAt": null,
    "createdAt": "…",
  },
}
```

These four counts are read from the **recipient rows** (the source of truth), not from the cached `sentCount`/`failedCount` on the session row — that's why the field names differ from the history endpoint. `delivered + dmClosed + failed + outstanding === targetCount`, so a progress bar can be driven directly from them.

Status meanings:

| Status       | Meaning for the UI                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `PENDING`    | queued, no job has run yet                                                                              |
| `PROCESSING` | in flight — keep polling                                                                                |
| `COMPLETED`  | every recipient reached a terminal state                                                                |
| `CANCELLED`  | an admin stopped it; `outstanding` recipients were **never attempted** (that's accurate, not a failure) |
| `FAILED`     | drained but recipients were still `PENDING` — a stalled or crashed worker. Investigate.                 |

`404` if the id is unknown.

#### 🔐 `GET /api/reminders/:id/recipients`

| Query    | Type   | Default | Rules                                               |
| -------- | ------ | ------- | --------------------------------------------------- |
| `page`   | number | 1       | ≥ 1                                                 |
| `limit`  | number | 50      | 1–200                                               |
| `status` | enum   | —       | `PENDING` \| `DELIVERED` \| `DM_CLOSED` \| `FAILED` |

**200** — sorted by `discordUsername` ascending, with `meta`:

```jsonc
{
  "meta": { "page": 1, "limit": 50, "total": 412 },
  "data": [
    {
      "id": "…",
      "memberId": "…",
      "status": "DM_CLOSED",
      "errorMessage": "Cannot send messages to this user",
      "sentAt": null,
      "member": {
        "discordUserId": "…",
        "discordUsername": "rakib_",
        "displayName": "Rakib",
      },
    },
  ],
}
```

Contact details (phone/email) are deliberately **not** exposed here — this is the delivery audit.

`DM_CLOSED` is not a failure of the system: the member has DMs closed. Those members get mentioned in `#daily-update-reminder` instead once the queue drains. Label it "DMs closed — mentioned in channel", not "failed".

`404` if the id is unknown.

#### 🔐 `POST /api/reminders/:id/cancel`

No body. **200** → the same payload as `GET /:id`, already showing `status: "CANCELLED"`.

| Status | Cause                                                              |
| ------ | ------------------------------------------------------------------ |
| 404    | unknown id                                                         |
| 409    | already `COMPLETED`/`FAILED`/`CANCELLED` — "…cannot be cancelled." |

Cancelling sets the session status; the worker re-reads it before every send, so in-flight and queued jobs stop delivering. Recipients never attempted stay `PENDING` — show them as "not attempted", never as failures.

#### 🔐 `GET /api/reminders/status`

Queue and worker health. No parameters.

```jsonc
{
  "data": {
    "workerRunning": true,
    "workerEnabled": true,
    "redisConnected": true,
    "redisError": null,
    "dmPerSecond": 2,
    "queueDepth": { "waiting": 196, "active": 2, "delayed": 0, "failed": 1 },
    "lastFallback": {
      "reminderId": "…",
      "ranAt": "…",
      "ok": false,
      "mentioned": 0,
      "error": "Missing Permissions",
      "missingPermission": true,
    },
  },
}
```

- `redisConnected: false` → `POST /send` will 503. Everything else in the app (API, bot, ingestion, scheduler) keeps working — say so, so nobody reboots the server.
- `queueDepth: null` → the queue object could not be reached (Redis down).
- **`lastFallback.missingPermission: true` is a silent failure.** Every DM delivered fine and the channel announcement reached nobody — precisely the members who most needed it. Surface it as an error banner: the bot needs `Send Messages` on `#daily-update-reminder`.

---

### 8.6 Attendance (public) — `/api/attendance`

🔓 **The only four routes in the application with no `auth()` middleware.** Students are not `users` rows, so there is no credential the form could present. What replaces authentication:

1. For `/verify-user`, `/verify-email` and `/submit`: the handle must resolve to a member with `isInGuild: true`; and (when the roster gate is armed) the email must be on the active enrolment list.
2. Per-IP rate limits (§9).

Both membership checks re-run on the write path — `submit` never trusts that either verify endpoint was called. `/window` exposes only the schedule submission window (no member data) and is rate limited.

#### 🔓 `GET /api/attendance/window`

Returns the current attendance submission window projection.

**No parameters.** Always **200** — this is a routine status query for the public form.

> `isOpen` is computed purely from the stored schedule row (`openTime`, `closeTime`, `daysOfWeek`, `enabled`) and the current Asia/Dhaka clock. It is **never** read from the live Discord channel permission overwrite, guaranteeing zero Discord API calls under high traffic. An admin locking the Discord channel manually will not affect `isOpen`.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Attendance window retrieved successfully",
  "data": {
    "isOpen": true, // whether the window is open right now
    "date": "2026-08-18", // today's Asia/Dhaka civil date
    "openTime": "19:00", // HH:mm, Asia/Dhaka
    "closeTime": "23:59", // HH:mm, Asia/Dhaka
    "daysOfWeek": [0, 1, 2, 3, 4, 5, 6], // 0=Sunday..6=Saturday
    "enabled": true, // false = paused (window never opens)
    "timezone": "Asia/Dhaka", // reported timezone constant
    "nextOpenAt": "2026-08-19T12:00:00.000Z", // next future opening instant (null when enabled: false)
    "closesAt": "2026-08-18T17:59:00.000Z", // closing instant for currently open window (null when isOpen: false)
    "emailVerificationRequired": false, // true = the email must be on the enrolled student list
  },
}
```

- **`nextOpenAt`** is reported even while the window is currently open (naming the _next_ occurrence). It is `null` only when `enabled` is `false`.
- **`closesAt`** is populated only when `isOpen` is `true`; otherwise it is `null`.
- **`emailVerificationRequired`** tells the form whether the email field is checked against the enrolment roster on submit. Read it on mount and label the field accordingly ("use the email you enrolled with") — otherwise a student first learns the rule from a 403 after filling the whole form. It is a **bare boolean**: the endpoint exposes no roster entry, no count, and no editor identity, and it still accepts no parameters, so there is nothing here to probe an address against. See §8.6A.
- The response carries **no admin-shaped fields**: no `updatedBy`, no `scheduler`, no `lastRun`, and no Discord channel or guild ID.

#### 🔓 `GET /api/attendance/verify-user?username=…`

| Query      | Type   | Rules                                                                                                                                |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `username` | string | required, trimmed, non-empty, must pass `/^(?!.*\.{2})[a-z0-9_.]{2,32}$/` after normalization (trim → strip leading `@` → lowercase) |

A leading or trailing `_` or `.` is **valid** (`.rabbil`, `itzazad_`). Don't tighten this client-side — an earlier stricter regex locked out 5.3% of real members.

**Always 200**, even when the handle is unknown — "not found" is a routine answer on the read path, and the form has to render something either way.

```jsonc
// verified, hasn't submitted anywhere — but member of two servers
{
  "success": true, "statusCode": 200,
  "message": "Discord username verified",
  "data": {
    "verified": true, "alreadySubmitted": false,
    "attendanceDate": "2026-08-17",
    "member": {
      "id": "…", "discordUserId": "…", "discordUsername": "rakib_",
      "displayName": "Rakib", "avatarUrl": "https://cdn.discordapp.com/…"
    },
    "servers": [
      { "guildId": "146…", "label": "Batch A", "alreadySubmitted": false },
      { "guildId": "246…", "label": "Batch B", "alreadySubmitted": true },
    ],
  }
}

// not a member (still HTTP 200!)
{
  "success": true, "statusCode": 200,
  "message": "This Discord username was not found in our Discord server. Please check the username, or join the server first.",
  "data": { "verified": false, "alreadySubmitted": false, "attendanceDate": "2026-08-17", "member": null, "servers": [] }
}
```

- `servers[]` lists **every** configured server this handle is currently a member of, each with its own `alreadySubmitted`.
- Top-level `alreadySubmitted` is `true` **only when every server already has today's row**. A member of two servers who submitted in one still has something to do — keep this on the form so the form knows to show "you still have to submit in Batch B".
- `member` is always `null` when `verified` is `false` — no partial disclosure.

**Branch on `data.verified`, never on the HTTP status.**

A malformed handle is a **400** (Zod). The form must tell "fix your typing" (400) apart from "you're not in the server" (200 + `verified: false`).

#### 🔓 `GET /api/attendance/verify-email?email=…`

| Query   | Type   | Rules                                                            |
| ------- | ------ | ---------------------------------------------------------------- |
| `email` | string | required, trimmed, must pass the standard email shape (`z.email`) |

**Always 200**, even when the address is not on the roster — "not enrolled" is the routine answer the form has to render as an inline hint, not a failure. `emailVerificationRequired` on the response tells the form whether the gate is currently armed.

```jsonc
// enrolled (gate armed)
{
  "success": true, "statusCode": 200,
  "message": "Email verified",
  "data": {
    "verified": true,
    "attendanceDate": "2026-08-17",
    "emailVerificationRequired": true,
  }
}

// not on the roster (still HTTP 200)
{
  "success": true, "statusCode": 200,
  "message": "This email address is not on our enrolled student list. Please use the email address you enrolled with, or contact an admin.",
  "data": {
    "verified": false,
    "attendanceDate": "2026-08-17",
    "emailVerificationRequired": true,
  }
}

// gate is OFF — no check is performed, so `verified` is deliberately false
{
  "success": true, "statusCode": 200,
  "message": "Roster check is currently disabled by an admin; no enrolment check was performed.",
  "data": {
    "verified": false,
    "attendanceDate": "2026-08-17",
    "emailVerificationRequired": false,
  }
}
```

- The endpoint is the email-side mirror of `/verify-user`: same envelope shape, same "always 200" rule, same live-badge use on the form. Wire them with the same `data.verified` branch.
- **The address is normalized (trim + lowercase) before lookup**, the same way `POST /submit` normalizes it, so a student pasting from a chat message that picked up trailing whitespace still resolves.
- **A deactivated/removed entry answers identically to one that was never on the roll** (`verified: false`, no other distinction). Same disclosure concern: telling those two apart would let anyone who can type an address confirm that a particular person used to be enrolled. Never show a "did you mean…" suggestion here; the API sends none.
- **When the gate is OFF** the endpoint reports `verified: false` and `emailVerificationRequired: false` for every well-formed address. There is no check to pass, so `verified` is deliberately `false` (reporting `true` would read as "this address is enrolled" for a check that never ran). The form should not nag about a check that is not happening — read `emailVerificationRequired` and only render the badge when it is `true`. Submit also bypasses the gate in this state, so the answer is consistent across read-time and write-time.
- The gate's current state also lives on `/window` (`data.emailVerificationRequired`). The two should always agree, since both read the same `roster_settings` row.

**Branch on `data.verified`, never on the HTTP status.** A malformed email is a **400** (Zod) — same rule as `/verify-user`: tell "fix your typing" (400) apart from "use the email you enrolled with" (200 + `verified: false`).

#### 🔓 `POST /api/attendance/submit`

**Body** — exactly these fields; anything else is stripped.

| Field                            | Type    | Rules                                                                                       |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `name`                           | string  | trimmed, 3–100 chars, `^[\p{L}\s]+$` — **Unicode letters**, so Bengali names are accepted   |
| `phone`                          | string  | trimmed, `^(?:\+?880\|0)1[3-9]\d{8}$` — `01711000000`, `+8801711000000`, or `8801711000000` |
| `email`                          | string  | valid email                                                                                 |
| `discordUsername`                | string  | same rule as `verify-user`                                                                  |
| `cannotEnterRealDiscordUsername` | boolean | optional; see "Discord-pairing mismatch" below                                              |

**201**

```jsonc
{
  "success": true,
  "statusCode": 201,
  "message": "Attendance submitted successfully for 2026-08-17",
  "data": {
    "attendanceDate": "2026-08-17",
    "submittedAt": "2026-08-17T14:22:31.000Z",
    "member": {
      "id": "…",
      "discordUserId": "…",
      "discordUsername": "rakib_",
      "displayName": "Rakib",
      "avatarUrl": "…",
    },
    "servers": [
      { "guildId": "146…", "label": "Batch A", "recorded": true,  "alreadySubmitted": false },
      { "guildId": "246…", "label": "Batch B", "recorded": true,  "alreadySubmitted": false },
    ],
    "reportQueued": false,
    "attendanceRecorded": true,
  },
}
```

The submission is recorded in **every** configured server the handle belongs to, in one transaction. The student submits once; the form does not ask them to pick a server. Each entry in `servers[]` carries `recorded` (was written by this request) and `alreadySubmitted` (was already on file from an earlier submission).

`reportQueued` and `attendanceRecorded` are both `true`/`false` flags exposing the two separate outcomes the form has to render differently. For a normal 201 response both are `true` (an attendance row was written) and `false` (no report was filed). See "Discord-pairing mismatch" below for the 202 / `reportQueued: true` / `attendanceRecorded: false` branch.

| Status  | Cause                                                                                  | Notes                                                                                        |
| ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400     | Zod                                                                                    | field-level; map `errorDetails.issues` to inputs                                             |
| **403** | email not on the enrolled student list                                                 | only when `emailVerificationRequired` is `true`. Point the student at the **email** field    |
| **403** | submitted handle does not match the recorded pairing                                  | see "Discord-pairing mismatch" below                                                         |
| **404** | handle unknown or the member has left the guild                                        | on the **write** path not-found is a genuine failure, unlike `verify-user`                   |
| 409     | already submitted today                                                                | message names the date: `You have already submitted your attendance for today (2026-08-17).` |
| **202** | `cannotEnterRealDiscordUsername: true` on a paired-but-mismatched submission          | report filed; attendance NOT recorded. Body carries `attendanceRecorded: false` and `reportQueued: true`. See "Discord-pairing mismatch" below |
| 429     | rate limit                                                                             | 5 per 15 min per IP                                                                          |

The 409 is enforced by a database unique constraint (`(memberId, attendanceDate)`), not a read-then-write check — two simultaneous submissions still produce exactly one row.

**403 (enrolled) and 403 (mismatch) are different fields.** A 403 with `emailVerificationRequired` set means the _email address_ is not on the enrolment roster; a 403 with the new "handle does not match the paired account" message means the _Discord handle_ does not match the one already recorded against that email. Branching on the message text (and not just the status) is what lets the form tell the student which input to fix.

The two checks are **independent**: the roster stores no Discord handle, and the matched entry does not have to describe the same person as the Discord account. What an accepted submission asserts is that an enrolled person's address was supplied _and_ that the submitting account is in a server — not that this particular enrolled person submitted.

The roster check runs **first**, so a request failing both is told about the email, and once that is corrected is told about the handle. A 403 never writes anything, in any server.

A refusal is deliberately identical whether the address was never enrolled or was removed from the roster — that collapse is what stops the endpoint being used to confirm who used to be enrolled. Never show a "did you mean…" suggestion here; the API sends none.

When `emailVerificationRequired` is `false` (the default, and the state until an admin arms it) the roster is not consulted at all and `submit` behaves exactly as it did before the feature existed.

**Discord-pairing mismatch.** Once a Discord pairing has been recorded for an email address, every later submission must use that handle. A submission with a different handle — but a valid one in a configured server — is refused with a 403 and this message:

```
This Discord username does not match the one already on file for your email address.
Please enter the correct Discord username, or check the box below to file
a Discord pairing mismatch report for an administrator to review.
```

The form's "I cannot enter my real Discord username" checkbox maps to `cannotEnterRealDiscordUsername`. When set to `true` on a refused submission, the submission is **NOT recorded as today's attendance**. Instead, a discord-pairing-mismatch report is queued against the pairing for an administrator to review, and the response is a **202 Accepted** with `attendanceRecorded: false` and `reportQueued: true`. The student is told the report was filed and that an admin will review; once the admin **reassigns** the pairing, the student's next submission goes through normally.

This is a deliberate change from the previous behaviour. The old behaviour accepted the flag as a recorded attendance AND filed a report in parallel, but the student-facing card was indistinguishable from a normal submit — so the student never knew the report existed, and the next submission still hit the same 403 until the admin reviewed. The report-only path makes the handoff explicit: today's attendance is NOT recorded, the report is queued, and the student can submit cleanly tomorrow once the admin finishes the review.

**202**

```jsonc
{
  "success": true,
  "statusCode": 202,
  "message": "Discord pairing mismatch report filed for 2026-08-17. An administrator will review it; once the pairing is confirmed, your next submission will be recorded as today's attendance.",
  "data": {
    "attendanceDate": "2026-08-17",
    "submittedAt": "2026-08-17T14:22:31.000Z", // the instant the report was filed, not an attendance row
    "member": {
      "id": "…",
      "discordUserId": "…",
      "discordUsername": "rakib_new", // the submitted handle, not the on-file one
      "displayName": "Rakib",
      "avatarUrl": "…",
    },
    "servers": [
      { "guildId": "146…", "label": "Batch A", "recorded": false, "alreadySubmitted": false },
      { "guildId": "246…", "label": "Batch B", "recorded": false, "alreadySubmitted": false },
    ],
    "reportQueued": true,
    "attendanceRecorded": false,
  },
}
```

- The status code is **202 Accepted**, not 201 — the work (recording today's attendance) is accepted as pending the administrator's review. Clients that branch on the status code read `attendanceRecorded` to know which card to render.
- `reportQueued: true` is the only signal back to the student that a report was filed. The student cannot view the report, the admin's notes, or its id.
- `attendanceRecorded: false` is the explicit "today's attendance is NOT recorded" signal. The form must render a clearly different success card on this branch — the standard "Attendance recorded" card would be a lie.
- `servers[].recorded` is `false` for every server, because no attendance row was written by this request.
- A second flag-set submission for the same entry on the same Dhaka day, while the first report is still open, returns the same 202 with `reportQueued: true` (the report was already on file; the partial-unique-index on `(roster_entry_id, submission_dhaka_date)` filtered by `status = 'OPEN'` prevents a duplicate row, and the service treats the conflict as a no-op).
- The flag is rejected as a 400 if it arrives as anything other than a JSON boolean (string, number, etc.).
- The flag is ignored (treated as `false`) when the submitted handle resolves to no current guild member — the membership refusal still wins.
- The flag is consumed only when the entry is paired and the handle differs. Unpaired entries are recorded as before, with `reportQueued: false` and `attendanceRecorded: true`.

**Branch on `data.attendanceRecorded`, not on the HTTP status alone.** A new client should switch on the boolean; an old client that only branches on the 201/202 split still works because the standard success card is 201 / `attendanceRecorded: true` and the report-only card is 202 / `attendanceRecorded: false`.

Listing and final-action endpoints for administrators live at `/api/roster/discord-mismatch-reports` (§8.6B).

---

### 8.6A Roster — `/api/roster`

All routes 🔐 **ADMIN**, without exception. This is the enrolment list — names, email addresses and phone numbers for every enrolled student — plus the switch that arms the email check on `POST /attendance/submit`. Nothing here is student-facing, and no route on it may ever be made public.

**The roster is global.** It carries no `guildId` and takes no server parameter. An email address identifies a _person_, not a membership, so someone enrolled in the program is enrolled everywhere — the same reasoning that keeps `guildId` off `reminder_logs` (§5A).

#### Turning the feature on, in order

| #   | Call                                                | What to check                                                      |
| --- | --------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `POST /roster/import`                               | `data.skipped` is 0, or the listed rows are ones you meant to skip |
| 2   | `GET /roster/settings`                              | `activeEntries` matches the size of your cohort                    |
| 3   | `PATCH /roster/settings` `{ "enforceEmail": true }` | takes effect on the next submission, no restart                    |

**Rollback is `PATCH /roster/settings { "enforceEmail": false }`** — one request, immediate, no deploy. Disabling always succeeds whatever the roster holds.

#### 🔐 `POST /roster/import`

`multipart/form-data`, one file in the **`file`** field. Accepts `.xlsx` and `.csv`.

Columns are located by **header name, never by position**, matched case-insensitively after trimming:

| Field            | Accepted headings                                                               |
| ---------------- | ------------------------------------------------------------------------------- |
| email (required) | `email`, `email address`, `e-mail`, `e mail`, `mail`                            |
| name (required)  | `name`, `full name`, `student name`, `fullname`                                 |
| phone (optional) | `phone`, `phone number`, `mobile`, `mobile number`, `contact`, `contact number` |

Unrecognized columns (batch, roll number, section) are ignored. Blank rows are skipped silently.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Imported 487 of 500 row(s); 13 skipped",
  "data": {
    "importId": "…",
    "fileName": "batch-11.xlsx",
    "totalRows": 500,
    "created": 412,
    "updated": 75,
    "skipped": 13,
    "duplicates": 2,
    "duplicateRowsCollapsed": 2,
    "rejectedRows": [
      { "rowNumber": 44, "reason": "Invalid email address: rakib@@x.com" },
    ],
    "duplicateAddresses": [
      { "email": "rakib@example.com", "rowNumbers": [12, 40] },
    ],
    "batchFailures": [],
  },
}
```

- **Partial success is a 200, not an error.** The valid rows really did load; an error status would say nothing happened and invite a re-upload. `created + updated + skipped + duplicateRowsCollapsed` always equals `totalRows` — the last term counts rows absorbed by an earlier row with the same address, which are neither written separately nor rejected.
- **`rejectedRows` carries the sheet's own row numbers** so the admin can fix those lines and re-upload.
- **An import upserts by email and can never remove anybody.** Entries absent from the sheet are left untouched and stay active, so a truncated or wrong-sheet upload adds noise rather than locking students out. Re-importing a deactivated person reinstates them, which makes re-upload idempotent and safe to retry.
- **`duplicateAddresses`** reports an address repeated inside one sheet. The **last** row wins; the repetition is surfaced because it is usually a mistake in the source spreadsheet.

| Status | Cause                                     | Notes                                                                                                                |
| ------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400    | no file, or wrong field name              | field must be `file`                                                                                                 |
| 400    | header row has no email or no name column | message names the headers found and the accepted headings. **Nothing is written** — every row would fail identically |
| 400    | legacy binary `.xls`                      | message says to re-save as `.xlsx`; the parser cannot read that format                                               |
| 400    | file over the size limit (default 5 MB)   | enforced while the upload streams, so it is never parsed                                                             |
| 400    | more rows than the limit (default 20 000) | a blast-radius control; nothing is written                                                                           |

#### 🔐 `GET /roster?search=&status=&page=&limit=`

`status` is `active` (default), `inactive`, or `all`. `search` matches name or email, case-insensitive and partial. `limit` maxes at 200. `meta.total` counts everything matching the same filter.

#### 🔐 `PATCH /roster/:id`

Correct one entry: `name`, `email`, `phone` (send `null` to clear the phone). At least one field required. Changing the email to one another entry holds is a **409** — never a silent merge.

#### 🔐 `DELETE /roster/:id` and `PATCH /roster/:id/restore`

`DELETE` **deactivates**; it never hard-deletes, so the removal is reversible and the audit trail survives. Only active entries count as enrolled. `restore` reinstates.

#### 🔐 `GET /roster/imports?page=&limit=`

Import history, most recent first: file name, the administrator, the time, and the counts. This is the audit trail for the only write path that can change who may submit attendance — check it first when the roll is not what someone expected.

#### 🔐 `GET /roster/settings` and `PATCH /roster/settings`

```jsonc
{
  "data": {
    "enforceEmail": false, // is the email check armed?
    "activeEntries": 2140, // how many people it would admit
    "updatedAt": "2026-08-19T13:00:00.000Z",
    "updatedBy": { "id": "…", "name": "Admin", "email": "admin@example.com" },
  },
}
```

`activeEntries` is returned next to the flag so the effect of arming is visible **before** it is armed.

| Status | Cause                               | Notes                                                                                                                                                            |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | enabling while `activeEntries` is 0 | refused on purpose: arming an empty gate refuses **every** student in every server with a correct-looking 403, and the only symptom is submissions going to zero |

There is deliberately **no** "skip the check when the roster is empty" behaviour on the submission path. The guard sits here, on the arming step, where a human reads the refusal — a gate that disarms itself under a condition nobody is watching is a gate nobody can reason about.

#### The roster engagement read model — `/roster/status/*`

Three endpoints surface the cohort from the **roster's** point of view: who that we enrolled is doing the work. They share a query vocabulary and are declared before `/roster/:id` for the same reason `/settings` is — Express would otherwise match `status` as an entry id.

**The denominator is ENROLMENT, not Discord membership.** Roster totals will not equal dashboard totals, and that is not a bug. The dashboard counts accounts; this counts enrolled people. The gap is exactly the people in one cohort but not the other:

- Enrolled but never joined a server → counted here, absent from the dashboard.
- In a server without being on the roll → counted on the dashboard, absent here.

Reconciling the two would erase a real distinction — these are different reports answering different questions.

**The roster has no `guildId`, and no filter here accepts one.** Sending `guildId` is a 400 ("The roster is not scoped to a server — guildId is not a valid filter here"). Narrow by pairing state and status instead.

Every endpoint here accepts **either** a single `date` **or** a `from`/`to` pair, with the same rules as the dashboard's range mode — see §5A. The span caps at **92 days**; a weekday set matching no day is a 400 with the same message the dashboard uses.

#### 🔐 `GET /api/roster/status/counts`

The seven-figure overview for a date or a range.

**Date mode:**

| Query  | Type   | Rules                       |
| ------ | ------ | --------------------------- |
| `date` | string | required, `YYYY-MM-DD`      |

**Range mode:** `from`, `to`, `daysOfWeek` (same rules as the dashboard).

**200**

```jsonc
// date mode
{
  "data": {
    "meta": { "mode": "date", "date": "2026-08-18" },
    "counts": {
      "date": "2026-08-18",
      "from": null, "to": null, "daysInRange": null,
      "enrolled": 2140,
      "paired": 1872,
      "unpaired": 268,
      "bothComplete": 1102,
      "missingUpdateOnly": 482,
      "missingAttendanceOnly": 88,
      "missingBoth": 200,
    },
  }
}

// range mode
{
  "data": {
    "meta": {
      "mode": "range",
      "from": "2026-08-15",
      "to": "2026-08-17",
      "daysOfWeek": null,
      "daysInRange": 3,
    },
    "counts": {
      "date": null,
      "from": "2026-08-15",
      "to": "2026-08-17",
      "daysInRange": 3,
      "enrolled": 2140,
      "paired": 1872,
      "unpaired": 268,
      "allComplete": 980,
      "partial": 612,
      "none": 280,
      "attendanceDays": 5040,
      "updateDays": 4120,
      "completeDays": 3940,
      "missedBothDays": 2480,
    },
  }
}
```

> ⚠️ **Roster totals do not equal dashboard totals.** Compare against `GET /api/daily-status/counts` for the same day and they will differ; that is two different questions answered by two different denominators, not a bug.

Range-mode person-day totals (`attendanceDays`, `updateDays`, `completeDays`, `missedBothDays`) count **person-days**, not people, and are named differently from the date-mode figures on purpose.

#### 🔐 `GET /api/roster/status`

Paginated listing of enrolled entries with their engagement state. **One row per enrolled person** — paired or not.

| Query          | Type     | Rules                                                                                              |
| -------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `date`         | string   | one of `date` OR (`from` AND `to`)                                                                 |
| `from`         | string   | range start, inclusive                                                                             |
| `to`           | string   | range end, inclusive                                                                               |
| `daysOfWeek`   | number[] | range mode only, each 0–6 (0 = Sunday), no duplicates                                              |
| `pairingState` | enum     | optional, `all` (default), `paired`, or `unpaired`                                                 |
| `status`       | enum     | optional, one of `COMPLETE`, `MISSING_UPDATE`, `MISSING_ATTENDANCE`, `MISSING_BOTH`, `NEVER_LINKED` |
| `search`       | string   | optional, case-insensitive partial match on **name or email**                                      |
| `sortBy`       | enum     | optional, `name`, `email`, `status`, `linkedAt` (unknown values fall back to `name`)               |
| `sortDir`      | enum     | optional, `asc` or `desc` (default `asc`)                                                          |
| `page`         | number   | default `1`, ≥ 1                                                                                   |
| `limit`        | number   | default `50`, 1–200                                                                                |

**200** — date mode:

```jsonc
{
  "meta": { "page": 1, "limit": 50, "total": 2140, "mode": "date", "date": "2026-08-18" },
  "data": [
    {
      "entryId": "…",
      "name": "Rakibul Hasan",
      "email": "rakib@example.com",
      "phone": "01711000000",
      "isActive": true,
      "discordUserId": "123456789012345678",
      "linkedAt": "2026-08-01T10:00:00.000Z",
      "servers": [{ "guildId": "146…", "label": "Batch A" }],
      "serverCount": 1,
      "discordUsername": "rakib_dev",
      "displayName": "Rakib",
      "isInGuild": true,
      "hasAttendance": true,
      "hasDailyUpdate": false,
      "status": "MISSING_UPDATE",
    },
  ],
}
```

**200** — range mode: same shape, but `status` is one of `ALL_COMPLETE` / `PARTIAL` / `NONE` / `NEVER_LINKED`, plus per-day counts:

| Field              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `daysInRange`      | Counted days — the denominator of everything below.                     |
| `attendanceDays`   | Days the person submitted the attendance form.                          |
| `updateDays`       | Days they posted a daily update, in any server.                         |
| `completeDays`     | Days they did **both**.                                                 |
| `incompleteDays`   | `daysInRange - completeDays` — days not fully done.                     |
| `missedBothDays`   | Days they did **neither**.                                              |
| `missedUpdateDays` | Days with no daily update, whatever attendance says.                    |

Unpaired entries have `discordUserId: null`, empty `servers`, and `status: "NEVER_LINKED"` (date mode) or `rangeStatus: "NEVER_LINKED"` (range mode). The roster cannot reach them on Discord; outreach happens by email outside this system.

#### 🔐 `GET /api/roster/status/export`

CSV attachment with the same query surface as the listing (minus paging — the export streams every match). Filenames include the period: `roster-status-2026-08-18.csv` for a date, `roster-status-2026-08-15_to_2026-08-17.csv` for a range. Columns are the listing's row fields plus `daysInRange`/`attendanceDays`/`updateDays`/`completeDays`/`incompleteDays`/`missedBothDays`/`missedUpdateDays`/`rangeStatus` for range mode.

| Status | Cause                       | Notes                                                                                |
| ------ | --------------------------- | ------------------------------------------------------------------------------------ |
| 501    | `format=xlsx`               | "XLSX export format is not supported yet. Please use format=csv." — same refusal the daily-status export uses |

---

### 8.6B Discord pairing mismatch reports — `/api/roster/discord-mismatch-reports`

All routes 🔐 **ADMIN**. Reports of attendance submissions where the submitted handle did not match the recorded Discord pairing for the same email, filed when the student ticked the `cannotEnterRealDiscordUsername` flag on `POST /api/attendance/submit` (§8.6).

When a report is filed, the student's submission is **NOT recorded as today's attendance**. The student gets a 202 Accepted with `attendanceRecorded: false` and `reportQueued: true`. After the admin **reassigns** the report, the student's next submission goes through normally and is recorded as today. The only signal back to the student that a report was filed is the 202 status code combined with `attendanceRecorded: false` and `reportQueued: true` on the response — the student cannot view the report, the admin's notes, or its id.

The first report for an entry on a given Dhaka date is recorded; subsequent mismatched submissions on the same day are absorbed by the partial unique index on `(roster_entry_id, submission_dhaka_date)` filtered by `status = 'OPEN'` and do not create duplicate rows.

Only one open report per entry per day can exist. Closing one (by `reassign` or `dismiss`) frees the entry for a fresh report the next day.

#### 🔐 `GET /api/roster/discord-mismatch-reports`

| Query      | Type     | Rules                                                                                              |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| `status`   | enum     | `open` (default), `reassigned`, or `dismissed`                                                     |
| `search`   | string   | optional, case-insensitive partial match on the entry's **name or email**                          |
| `dateFrom` | string   | optional, ISO 8601 datetime; inclusive lower bound of `reportedAt`                                 |
| `dateTo`   | string   | optional, ISO 8601 datetime; inclusive upper bound of `reportedAt`                                 |
| `page`     | number   | default `1`, ≥ 1                                                                                   |
| `limit`    | number   | default `50`, 1–200                                                                                |

`pairedAccountId` and `submittingAccountId` are **rejected** as 400 even when present — the listing must not let a caller enumerate Discord account snowflakes.

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Discord pairing mismatch reports retrieved successfully",
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 12,
    "status": "open",
  },
  "data": {
    "items": [
      {
        "id": "…",
        "entryId": "…",
        "entryName": "Rakibul Hasan",
        "entryEmail": "rakib@example.com",
        "pairedDiscordUsername": "rakib_dev",
        "pairedDisplayName": "Rakib",
        "submittingDiscordUsername": "rakib_real",
        "submittingDisplayName": "Rakib Real",
        "submittedHandle": "rakib_real",
        "reason": "HANDLE_MISMATCH_PAIRING",
        "submissionDhakaDate": "2026-08-19",
        "reportedAt": "2026-08-19T14:23:11.000Z",
        "status": "open",
      },
    ],
    "total": 12,
  },
}
```

Paired / submitting account identifiers are **never** exposed — only the normalized handles, so the dashboard can render "this Discord username was filed against this pairing" without leaking either account snowflake to a wider surface than necessary.

| Status | Cause                              | Notes                                                                                                                            |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `pairedAccountId` filter supplied  | "The listing does not accept a paired-account filter — it would let callers enumerate Discord accounts"                           |
| 400    | `submittingAccountId` filter supplied | same message, naming the rejected field                                                                                        |

#### 🔐 `POST /api/roster/discord-mismatch-reports/:id/action`

```jsonc
{
  "action": "reassign" // or "dismiss"
}
```

Anything else in `action` (or anything else in the body) is a 400. The only two values are `reassign` and `dismiss`.

**REASSIGN** rewrites the entry's pairing to the submitted account — but only if the entry still holds the originally paired account. A single conditional write (`WHERE id = :entryId AND discordUserId = :pairedAccountId`) preserves the invariant against a stale dashboard; if the entry's pairing has moved on, the update matches zero rows and the action is refused as a conflict. The report and the pairing rewrite are in one transaction; either both happen or neither does.

REASSIGN also checks membership: reassigning to a Discord account that is no longer in any configured guild is refused with **422** — the entry would end up paired to nothing. The administrator can `dismiss` the report instead.

**DISMISS** closes the report and leaves the pairing untouched. No membership check; the recorded pairing is the administrator's decision that the existing record is correct.

Either action on a closed report is refused as a conflict with the current status.

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Report reassigned; the entry pairing has been updated",
  "data": {
    "id": "…",
    "status": "reassigned",
    "reviewedByAdminId": "…",
    "reviewedAt": "2026-08-19T14:30:00.000Z",
    "rosterEntryId": "…",
  },
}
```

| Status | Cause                                                | Notes                                                                                                                       |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | unknown `action` value, or other fields in the body  | Zod field-level error                                                                                                       |
| 404    | unknown report id                                    | "Mismatch report not found"                                                                                                 |
| 409    | report already closed                                | message names the current status (`reassigned` or `dismissed`)                                                              |
| 409    | entry no longer holds the originally paired account  | "The pairing on this entry has changed since the report was filed; refresh and review the current pairing before reassigning" — REASSIGN only |
| 422    | submitted account is not in any configured guild     | REASSIGN only; the message names every configured guild. The report stays open — `dismiss` remains available.                |

The action writes an audit-log entry with the action, the report id, the reviewing administrator, and the time.

---

### 8.7 Attendance announcement — `/api/announcement`

All routes 🔐. This is the evening message posted into `#attendance` — the one that tells ~5,000 students to submit. Nothing here is student-facing, unlike §8.6.

Two things make this section different from the schedule in §8.4: the message body is **admin-editable free text**, and the send can **mention the whole guild**. Both are covered below.

#### 🔐 `GET /api/announcement/attendance`

No parameters. The row is created lazily on first read (the current Bangla message, 19:00, all seven days, enabled, nothing mentioned), so this never 404s.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Attendance announcement retrieved successfully",
  "data": {
    "template": {
      "body": "Date: {{date}}\nসবাই রাত {{close_time}} …",
      "terminationDays": 3,
      "mentionEveryone": false,
      "mentionRoleIds": [],
      "mentionUsernames": [],
      "updatedAt": "…",
      "updatedBy": { "id": "…", "name": "Rakib", "email": "…" },
    },
    "schedule": {
      "announceTime": "19:00",
      "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
      "enabled": true,
      "timezone": "Asia/Dhaka",
    },
    "preview": {
      "content": "Date: 2026-08-18\nসবাই রাত 23:59 … <#1466…>",
      "length": 537,
      "limit": 2000,
      "closeTime": "23:59",
      "mentions": { "roleIds": [], "userIds": [], "unresolved": [] },
    },
    "supportedPlaceholders": ["{{date}}", "{{close_time}}", "…"],
    "scheduler": {
      "processEnabled": true,
      "running": true,
      "nextRunAt": "2026-08-18T13:00:00.000Z",
      "lastOutcome": null,
    },
    "channel": { "id": "1467526520347037729" },
    "today": {
      "date": "2026-08-18",
      "posted": true,
      "servers": [
        {
          "guildId": "146…",
          "label": "Batch A",
          "channelId": "1467526520347037729",
          "posted": true,
          "lastOutcome": { "status": "posted", "trigger": "SCHEDULED", "at": "2026-08-18T13:00:00.000Z" },
          "attempts": [
            {
              "attempt": 1,
              "status": "POSTED",
              "trigger": "SCHEDULED",
              "discordMessageId": "1234567890123456789",
              "unresolvedTargets": [],
              "error": null,
              "createdAt": "2026-08-18T13:00:01.000Z",
              "updatedAt": "2026-08-18T13:00:04.000Z",
            },
          ],
        },
        {
          "guildId": "246…",
          "label": "Batch B",
          "channelId": "246…",
          "posted": false,
          "lastOutcome": { "status": "failed", "error": "Missing permission: Send Messages", "at": "2026-08-18T13:00:02.000Z" },
          "attempts": [
            {
              "attempt": 1,
              "status": "FAILED",
              "trigger": "SCHEDULED",
              "discordMessageId": null,
              "unresolvedTargets": [],
              "error": "Missing permission: Send Messages",
              "createdAt": "2026-08-18T13:00:01.000Z",
              "updatedAt": "2026-08-18T13:00:02.000Z",
            },
          ],
        },
      ],
    },
  },
}
```

- **`template.body` is the raw text with placeholders unexpanded — that is what the editor binds to.** `preview.content` is the same body rendered against today's live values plus the mention line, i.e. exactly what students would read. Never show `preview.content` in an editable field; a round-trip would bake today's date into the stored template.
- **`preview.closeTime` is read from the `#daily-update` schedule** (§8.4), not stored here. Changing the close time there changes this message without anyone editing it. That is the whole point — don't offer a close-time field on this screen.
- `today.posted` is `true` only when **every** configured server has today's message; `today.servers[]` reports each server individually so a silent server cannot hide behind a single green flag. An attempt stuck in `SENDING` means a crash between the claim and the post; a forced send (below) recovers it.
- **`scheduler.lastOutcome` is where a missing `Send Messages` permission shows up.** Surface it — the only other symptom is a channel that quietly stops being announced in.
- `channel.id` is reported per server under `today.servers[].channelId`; the top-level `channel` shape is deprecated and only kept for clients still binding to it.
- There is deliberately **no boot reconcile**: a missed announcement is never posted late. If `today.posted` is false after `nextRunAt` has passed, that day needs a manual send.
- Costs no Discord API call for the channel state (unlike §8.4), but it **does** resolve mention targets, so don't poll it tightly.

#### 🔐 `PATCH /api/announcement/attendance`

**Body** — a patch; every field optional, but **an empty object is rejected (400)**.

| Field              | Type     | Rules                                                               |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `body`             | string   | non-empty; only the supported placeholders                          |
| `terminationDays`  | number   | integer 1–365                                                       |
| `mentionEveryone`  | boolean  | see the warning below                                               |
| `mentionRoleIds`   | string[] | each a 17–20 digit snowflake, no duplicates; `[]` clears            |
| `mentionUsernames` | string[] | Discord handles, normalized server-side, no duplicates; `[]` clears |
| `announceTime`     | string   | 24-hour `HH:mm`, `00:00`–`23:59`                                    |
| `daysOfWeek`       | number[] | ≥ 1 entry, each 0–6 (0 = Sunday), no duplicates                     |
| `enabled`          | boolean  | pauses the timed post, keeps everything else                        |

Do **not** send `timezone` — Zod strips it silently; the zone is fixed.

**Two service-level 400s (not from Zod, so the message arrives un-Title-Cased and is safe to show verbatim):**

1. **Unknown placeholder.** `{{attendance_link}}` in the body →
   `Unknown placeholder(s): {{attendance_link}}. Supported placeholders are {{date}}, {{close_time}}, {{daily_update_channel_id}}, {{attendance_form_link}}, {{termination_day}}.`
   Render `supportedPlaceholders` as click-to-insert chips and this becomes hard to hit.
2. **Too long once rendered.** The check measures the **rendered** message plus the mention line against Discord's 2,000 characters, not the raw body. A body that looks short can still fail once placeholders expand and twelve role pings are appended. Show `preview.length / preview.limit` live as they type — the counter must be driven by the preview, not by `body.length`.

> ⚠️ **`mentionEveryone: true` pings every member of the guild, every evening, until it is turned off.** It is the only way the announcement can notify the whole server — a literal `@everyone` typed into `body` is inert, because `allowedMentions` is built from these fields alone and never parsed from the text. Put this behind an explicit confirmation that names the member count, and show it prominently on the read screen. The admin who set it is recorded in `template.updatedBy`.

**200** → the same payload shape as `GET`, already reflecting the change. Changing `announceTime`, `daysOfWeek`, or `enabled` rebuilds the cron task in-process; no restart needed.

**Changing `announceTime` also moves the `#daily-update` channel's opening time**, in the same transaction — the channel opens when this announcement is posted. Both cron tasks are rebuilt, and the channel is reconciled immediately, so a time that has already passed today opens the channel now rather than tomorrow. Re-fetch `GET /api/schedule/daily-update` after this call, and expect a **400** if `announceTime` is not strictly earlier than the schedule's `closeTime` (it would leave students no window to post in). A reload failure does **not** fail the request (the row is saved) — it surfaces under `scheduler` on the next read.

```ts
// actions/announcement.ts
'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { AnnouncementPayload } from '@/lib/api/types';

export async function updateAnnouncement(input: {
  body?: string;
  terminationDays?: number;
  mentionEveryone?: boolean;
  mentionRoleIds?: string[];
  mentionUsernames?: string[];
  announceTime?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
}) {
  try {
    const data = await api<AnnouncementPayload>('/announcement/attendance', {
      method: 'PATCH',
      body: input,
    });
    revalidatePath('/dashboard/announcement');
    return { data };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}
```

Build the schedule half as a time picker + weekday checkboxes. **Never expose a cron field** — same rule as §8.4.

#### 🔐 `POST /api/announcement/attendance/preview`

**Body** — `{ body?: string, terminationDays?: number }`. Both optional; omit everything to preview what is stored.

Renders against today's live values and **stores nothing**. Use it for the live preview pane while an admin types (debounce it — it resolves mention targets on each call).

**200** → `data: AnnouncementPreview`. Rejects an unknown placeholder with the same 400 as `PATCH`, so the editor can show the error before anyone saves.

#### 🔐 `POST /api/announcement/attendance/send`

**Body** — `{ force?: boolean, guildIds?: string[] }` (both default to absent).

| Field      | Type      | Rules                                                                                       |
| ---------- | --------- | ------------------------------------------------------------------------------------------- |
| `force`    | boolean   | default `false`; only escape from the once-per-day claim                                    |
| `guildIds` | string[]  | optional, each a 17–20 digit snowflake; restricts the send to named configured servers. Omit to target every configured server. `[]` is rejected — pass nothing instead. |

Posts **immediately**, leaving the stored schedule untouched. Works on every process, including one where `SCHEDULER_ENABLED=false`.

**It also opens `#daily-update` in the servers it posted to.** The message tells students to submit and the window is what lets them, so one click does both — a send that announced a window nobody could post in would be worse than no send.

**200** → `data: AnnouncementSendResult`:

```jsonc
{
  "data": {
    "announcementDate": "2026-08-18",
    "summary": {
      "total": 2,
      "posted": 1,
      "failed": 1,
      "alreadySent": 0,
    },
    "servers": [
      {
        "guildId": "146…", "label": "Batch A",
        "status": "posted",
        "discordMessageId": "1234567890123456789",
        "unresolvedTargets": [],
      },
      {
        "guildId": "246…", "label": "Batch B",
        "status": "failed",
        "missingPermission": "SendMessages",
        "error": "Missing permission: Send Messages",
      },
    ],
    "channel": {
      "opened": ["146…"],
      "alreadyOpen": [],
      "failed": [{ "guildId": "246…", "label": "Batch B", "error": "Missing permission: Manage Roles" }],
      "locksAt": "23:59",
    },
  },
}
```

`summary` totals the per-server outcomes and the message line under `success` switches between two forms (`"Attendance announcement posted"` when `summary.posted === summary.total`, otherwise `"Attendance announcement posted to N of M server(s)"`) so the admin can see the partial from the toast alone.

| Status | Cause                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------- |
| 409    | every targeted server already posted today — `{ "force": true }` is the only way past it          |
| 403    | the bot lacks `Send Messages` on the attendance channel of **every** targeted server              |
| 503    | no configured server has a verified attendance channel, the bot is not connected, or every server failed |

- **At most one post per Dhaka day, per server**, enforced by a database claim rather than by timing — a double-clicked button gets the 409, not a second message. `{ "force": true }` is the only way to post twice in one day and files the second one as the next `attempt`.
- **A failed send does not consume the day** for that server. After fixing a permission, retry plainly; no `force` needed.
- This is **outward-facing and irreversible** — potentially a mass mention to thousands of students. Put it behind a confirmation dialog that shows `preview.content` and, when `mentionEveryone` is on, says so explicitly. The same dialog should surface the target server set (`guildIds` if supplied, otherwise every configured server) so a wrong list is caught before clicking.
- **Partial success is a 200, not an error.** Posting really did happen somewhere, and answering an error would invite a retry that re-posts nothing while looking like the fix. Inspect `data.servers[]` and `data.summary.failed` to render the warning next to the success.
- **Read `data.channel` after every send.** `opened` is where the window was opened, `alreadyOpen` is where it already was (skipped, so a forced second send does not post a second "Channel is OPEN" embed), and `failed` is where the announcement went out but the channel did **not** open — usually a missing `Manage Roles`, and worth showing as a warning next to the success, since those students can read the message and cannot act on it.
- **`channel.locksAt` is `null` when the channel schedule is disabled**, meaning no lock job is registered and the window this send opened will stay open past midnight — where a post lands on the _next_ day's record. Surface it: the admin has to lock it by hand at `POST /api/schedule/daily-update/lock`.
- Only servers this run **posted** to are opened. A server whose post failed was never told to submit, and one that answered `already-sent` was opened when that earlier post went out.
- The stored open time is **not** changed. A send at 20:30 is a moment, not a new schedule; tomorrow still opens at `announceTime`.
- An unknown ID in `guildIds` is a 400 naming every invalid ID. `GET /api/discord/servers` lists the configured ones.

---

### 8.8 Daily status — `/api/daily-status`

All routes 🔐. These endpoints feed the admin daily status dashboard, member status table, member history dialog, and CSV export.

#### 🔐 `GET /api/daily-status/counts`

**Date mode:**

| Query     | Type   | Rules                                       |
| --------- | ------ | ------------------------------------------- |
| `date`    | string | required, `YYYY-MM-DD`, valid calendar date |
| `guildId` | string | optional, restrict to one configured server |

**Range mode:** `from`, `to`, `daysOfWeek` (same rules as §5A). `from`/`to` are mutually exclusive with `date`; sending both, or only one half, is a 400.

**200** — date mode:

```jsonc
{
  "data": {
    "date": "2026-08-18",
    "totalMembers": 5187,
    "attendanceSubmitted": 4320,
    "dailyUpdateSubmitted": 3000,
    "bothComplete": 2800,
    "missingUpdateOnly": 1520,
    "missingAttendanceOnly": 200,
    "missingBoth": 667,
    "byServer": [
      {
        "guildId": "146…", "label": "Batch A",
        "totalMembers": 3000, "attendanceSubmitted": 2510,
        "dailyUpdateSubmitted": 1700, "bothComplete": 1600,
        "missingUpdateOnly": 910, "missingAttendanceOnly": 120, "missingBoth": 370,
      },
      {
        "guildId": "246…", "label": "Batch B",
        "totalMembers": 2400, "attendanceSubmitted": 1900,
        "dailyUpdateSubmitted": 1450, "bothComplete": 1320,
        "missingUpdateOnly": 640, "missingAttendanceOnly": 95,  "missingBoth": 345,
      },
    ],
  },
}
```

**200** — range mode:

```jsonc
{
  "data": {
    "mode": "range",
    "from": "2026-08-15",
    "to": "2026-08-17",
    "daysOfWeek": null,
    "daysInRange": 3,
    "totalMembers": 5187,
    "allCompleteMembers": 2100,
    "partialMembers": 2200,
    "noneMembers": 887,
    "attendanceDays": 13000,
    "updateDays": 9800,
    "completeDays": 9100,
    "missedBothDays": 6450,
    "byServer": [
      {
        "guildId": "146…", "label": "Batch A",
        "totalMembers": 3000, "allCompleteMembers": 1180,
        "partialMembers": 1320, "noneMembers": 500,
        "attendanceDays": 7600, "updateDays": 5600,
        "completeDays": 5200, "missedBothDays": 3800,
      },
      { "guildId": "246…", "label": "Batch B", "…" },
    ],
  },
}
```

- Every count is guaranteed to be a JSON **number**, not a bigint.
- Date-mode invariant: `bothComplete + missingUpdateOnly + missingAttendanceOnly + missingBoth === totalMembers`. Range-mode invariant: `allCompleteMembers + partialMembers + noneMembers === totalMembers`.
- Person-day totals in range mode scale with the span and are **named differently** from the date-mode figures on purpose — they count person-days, not people.
- > ⚠️ **`byServer` does NOT sum to the combined totals.** Combined figures count people; `byServer` counts memberships. The difference is exactly the number of people in more than one server. Show them as two separate readings, not as a total and its parts.
- An unknown `guildId` is a 400 naming it.
- **Past dates work.** The frontend 7-day trend chart calls this endpoint 7 times in parallel for historical days.

#### 🔐 `GET /api/daily-status`

Paginated per-person status list.

| Query               | Type       | Rules                                                                                          |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `date`              | string     | one of `date` OR (`from` AND `to`)                                                             |
| `from`              | string     | range start, inclusive                                                                         |
| `to`                | string     | range end, inclusive                                                                           |
| `daysOfWeek`        | number[]   | range mode only, each 0–6 (0 = Sunday)                                                         |
| `guildId`           | string     | optional, restrict to one configured server                                                    |
| `page`              | number     | default `1`, integer ≥ 1                                                                       |
| `limit`             | number     | default `50`, integer 1–200                                                                    |
| `status`            | enum       | date mode only: `COMPLETE` \| `MISSING_UPDATE` \| `MISSING_ATTENDANCE` \| `MISSING_BOTH`       |
| `rangeStatus`       | enum       | range mode only: `ALL_COMPLETE` \| `PARTIAL` \| `NONE`                                        |
| `minMissedBothDays` | number     | range mode only, integer ≥ 1 — keep only accounts with at least this many `missedBothDays`     |
| `search`            | string     | optional, case-insensitive partial on name, phone, email, or `discordUsername`                 |
| `sortBy`            | enum       | range mode only: `name` \| `missedBothDays` \| `completeDays` \| `rangeStatus` (default `name`) |
| `sortDir`           | enum       | range mode only: `asc` \| `desc` (default `asc`)                                              |

Using the wrong status filter for the current mode (`status` in range mode, or `rangeStatus` in date mode) is a 400 — never silently ignored.

**200** — date mode:

```jsonc
{
  "meta": { "page": 1, "limit": 50, "total": 1520 },
  "data": [
    {
      "memberId": "cm1234567890",
      "discordUserId": "123456789012345678",
      "discordUsername": "rakib_dev",
      "displayName": "Rakib",
      "name": "Rakibul Hasan",
      "email": "rakib@example.com",
      "phone": "01711000000",
      "hasAttendance": true,
      "hasDailyUpdate": false,
      "status": "MISSING_UPDATE",
      "attendanceSubmittedAt": "2026-08-18T14:22:31.000Z",
      "servers": [{ "guildId": "146…", "label": "Batch A" }],
      "serverCount": 1,
      "memberIds": ["cm1234567890"],
    },
  ],
}
```

**200** — range mode: each row replaces `status`/`hasAttendance`/`hasDailyUpdate` with:

| Field              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `daysInRange`      | Counted days — the denominator of everything below.                     |
| `attendanceDays`   | Days the person submitted the attendance form.                          |
| `updateDays`       | Days they posted a daily update, in any server.                         |
| `completeDays`     | Days they did **both**.                                                 |
| `incompleteDays`   | `daysInRange - completeDays` — days not fully done.                     |
| `missedBothDays`   | Days they did **neither**.                                              |
| `missedUpdateDays` | Days with no daily update, whatever attendance says.                    |
| `rangeStatus`      | `ALL_COMPLETE` / `PARTIAL` / `NONE`.                                    |

> ⚠️ **`incompleteDays` and `missedBothDays` are different numbers.** Someone who submits attendance every day and never posts an update has `incompleteDays = daysInRange` and `missedBothDays = 0`. The reminder threshold acts on **`missedBothDays`**, so show that column wherever an admin is about to choose a threshold. There is deliberately no field called `missedDays`.

`meta.total` is the **filtered** row count (matching the active search/status filters), driving the UI pager. Within a `guildId`-filtered view, `servers.length` may be 1 while `serverCount` is 2 — the latter is the total membership, never narrowed.

#### 🔐 `GET /api/daily-status/members/:memberId`

Detailed status for a specific member, including their posted `#daily-update` messages. Like the listing, this endpoint accepts either a single date or a range; the resolved period is echoed in the response so the caller never has to infer the mode.

| Param      | Type      | Rules                                                                              |
| ---------- | --------- | ---------------------------------------------------------------------------------- |
| `memberId` | string    | **required** path, member CUID/ID — any one record for the account, the rest is resolved from it |
| `date`     | string    | one of `date` OR (`from` AND `to`), same rules as §8.8 listing                      |
| `from`     | string    | range start, inclusive                                                              |
| `to`       | string    | range end, inclusive                                                                |
| `daysOfWeek` | number[] | range mode only, each 0–6 (0 = Sunday)                                             |

**200** — date mode:

```jsonc
{
  "data": {
    "mode": "date",
    "date": "2026-08-18",
    "memberId": "cm1234567890",
    "discordUserId": "123456789012345678",
    "discordUsername": "rakib_dev",
    "displayName": "Rakib",
    "name": "Rakibul Hasan",
    "email": "rakib@example.com",
    "phone": "01711000000",
    "hasAttendance": true,
    "hasDailyUpdate": true,
    "status": "COMPLETE",
    "attendanceSubmittedAt": "2026-08-18T14:22:31.000Z",
    "servers": [{ "guildId": "146…", "label": "Batch A" }, { "guildId": "246…", "label": "Batch B" }],
    "serverCount": 2,
    "memberIds": ["cm1234567890", "cm0987654321"],
    "messages": [
      {
        "id": "cmupdate123",
        "content": "Today I implemented the public window endpoint.",
        "postedAt": "2026-08-18T18:40:12.000Z",
        "guildId": "146…",
        "serverLabel": "Batch A",
      },
    ],
  },
}
```

**200** — range mode: replaces `status`/`hasAttendance`/`hasDailyUpdate` with the same per-day figures as the listing (see §8.8 `/api/daily-status` table), and adds two top-level arrays:

| Field       | Type                  | Meaning                                                                              |
| ----------- | --------------------- | ------------------------------------------------------------------------------------ |
| `days`      | `DailyStatusRangeDay[]` | One entry per counted day, with that day's `status` and `hasAttendance`/`hasDailyUpdate`. Reconciles with `completeDays`/`missedBothDays`. |
| `messages`  | array                 | Every message posted in the range, across every server, as one ordered timeline. Each entry names the server it came from (`guildId` + `serverLabel`). |

`meta` is omitted in the detail view — the period echoes are top-level on `data` for parity with `getCounts`.

- `servers` is the **filtered** list (narrowed by any active `guildId`); `serverCount` is the **unfiltered** total so a single-server view still shows the person is also elsewhere.
- `memberIds` lists every member record for this account, aligned with `servers`. Use it to look up per-server data; never derive server membership from a single `memberId`.
- Messages posted in this person's other server **do** appear — the read is over `memberIds`, not the path parameter.
- `messages: []` when nothing was posted in the period (or on the date).
- **404** if `memberId` does not resolve to any account.

#### 🔐 `GET /api/daily-status/export`

Exports filtered daily status rows as a direct file attachment. Accepts the same `date` XOR `from`/`to` period as the listing; the date form keeps the original column set and the range form gets the per-day figures.

| Query               | Type     | Rules                                                                |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `date`              | string   | one of `date` OR (`from` AND `to`), same rules as §8.8 listing       |
| `from`              | string   | range start, inclusive                                               |
| `to`                | string   | range end, inclusive                                                 |
| `daysOfWeek`        | number[] | range mode only                                                      |
| `guildId`           | string   | optional, restrict to one configured server                         |
| `status`            | enum     | date mode only, same filter as table                                 |
| `rangeStatus`       | enum     | range mode only: `ALL_COMPLETE` \| `PARTIAL` \| `NONE`              |
| `minMissedBothDays` | number   | range mode only, integer ≥ 1 — same filter as table                  |
| `search`            | string   | optional, same search as table                                       |
| `format`            | string   | optional, `csv` (default). **`xlsx` returns 501 Not Implemented.**   |

**200** — date mode (file attachment):

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="daily-status-2026-08-18.csv"
```

**200** — range mode (file attachment):

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="daily-status-2026-08-15_to_2026-08-17.csv"
```

When `guildId` is supplied the server's display label is folded into the filename (label-safe characters only) so two downloads of overlapping periods for different servers do not overwrite each other:

```
Content-Disposition: attachment; filename="daily-status-2026-08-15_to_2026-08-17-Batch-A.csv"
```

**Columns** — date mode (one row per person):

```
servers, discordUsername, displayName, name, phone, email,
status, hasAttendance, hasDailyUpdate, attendanceSubmittedAt
```

**Columns** — range mode (one row per person):

```
servers, discordUsername, displayName, name, phone, email,
rangeStatus, daysInRange, attendanceDays, updateDays, completeDays,
incompleteDays, missedBothDays, missedUpdateDays, lastAttendanceSubmittedAt
```

The leading `servers` cell joins every server the person is in with `" | "` (one row per person, never one row per server membership). Filtering by `guildId` does **not** narrow this column to one entry — it narrows which **people** appear, and that person's full server list is preserved for context.

- Streams batches of 500 rows so thousands of accounts export without memory pressure.
- Escapes spreadsheet formula injection by prepending `'` to values starting with `=`, `+`, `-`, or `@`.
- `format=xlsx` is **501 Not Implemented** in both modes; see §13.

---

### 8.9 Root

`GET /` → `Hello, World!` (plain text, not the envelope). Usable as a liveness probe. There is **no** `/api/health` endpoint.

---

## 9. Rate limits

| Endpoint                          | Budget | Window | Applies to |
| --------------------------------- | ------ | ------ | ---------- |
| `GET /api/attendance/window`      | 60     | 1 min  | per IP     |
| `GET /api/attendance/verify-user` | 60     | 1 min  | per IP     |
| `GET /api/attendance/verify-email` | 60    | 1 min  | per IP     |
| `POST /api/attendance/submit`     | 5      | 15 min | per IP     |

Everything else is unlimited but admin-only.

429 responses use the **normal `sendResponse` envelope** (`success: false`, `data: null`) plus standard `RateLimit-*` headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`). Read `RateLimit-Reset` to show "try again in N seconds".

Frontend implications:

- Debounce `verify-user` and `verify-email` at **500 ms** minimum. 60/min covers a student typing, backspacing, and retrying — but a per-keystroke call will exhaust it.
- Cancel the in-flight verify request on each new keystroke (`AbortController`) so a stale response can't overwrite a newer one.
- Disable the submit button while a submit is in flight, and don't auto-retry a failed submit — 5 attempts per 15 minutes is the whole budget.

> The counting store is **process-local** (in-memory). If the backend is ever scaled to N processes the effective budget becomes N×. That's a known, deliberate trade-off documented in `rateLimit.ts` — don't design the frontend around a tighter guarantee.

---

## 10. Caching and revalidation strategy per endpoint

`fetch` is uncached by default in Next 16, which is the right default here — almost everything on this dashboard is operational state. Use `use cache` sparingly.

| Endpoint                        | Strategy                                             | Why                                          |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `GET /users/me`                 | `no-store` + React `cache()` per render              | `lastActiveAt` changes on every request      |
| `GET /discord/sync/status`      | `no-store`, client-poll 5 s while `lastSync.running` | live counters                                |
| `GET /schedule/daily-update`    | `no-store` **always**                                | `channel.isOpen` is a live Discord read      |
| `GET /reminders`                | `no-store`; `revalidatePath` after send/cancel       | short list, cheap                            |
| `GET /reminders/:id`            | `no-store`, poll 2–3 s while `PENDING`/`PROCESSING`  | see §11                                      |
| `GET /reminders/:id/recipients` | `no-store`; refetch on page change                   | paginated audit                              |
| `GET /reminders/status`         | `no-store`, poll 10 s on the reminders page          | queue health                                 |
| `GET /reminders/targets`        | `no-store`                                           | the preview must match what `send` will do   |
| `GET /attendance/window`        | `no-store`, client-side, on form mount               | submission window changes with schedule/time |
| `GET /attendance/verify-user`   | `no-store`, client-side, debounced                   | membership changes minute to minute          |
| `GET /attendance/verify-email`  | `no-store`, client-side, debounced                   | roster arms/disarms and entries change       |
| `GET /daily-status/counts`      | `no-store`                                           | live aggregation for date                    |
| `GET /daily-status`             | `no-store`; refetch on filter/search/page change     | paginated daily status table                 |
| `GET /daily-status/members/:id` | `no-store`                                           | member messages and status                   |
| `GET /daily-status/export`      | `no-store` (direct file download)                    | CSV export                                   |
| `GET /announcement/attendance`  | `no-store`; `revalidatePath` after save/send         | `preview` and `today.posted` must be current |
| `POST /announcement/…/preview`  | `no-store`, client-side, debounced ≥ 500 ms          | resolves mention targets on every call       |

Mutations should `revalidatePath` the pages they affect, or `revalidateTag` if you tag reads. After a Server Action that only needs the client router refreshed (no tagged data), `refresh()` from `next/cache` is enough.

Wrap slow server reads in `<Suspense>` rather than relying on `loading.tsx` alone — a layout that reads `cookies()` blocks its own segment's `loading.tsx`, and every authenticated read here reads cookies.

```tsx
// app/(dashboard)/reminders/page.tsx
import { Suspense } from 'react';
import { QueueHealth, QueueHealthSkeleton } from './queue-health';
import { BroadcastHistory, HistorySkeleton } from './history';

export default function RemindersPage() {
  return (
    <>
      <h1>Reminders</h1>
      <Suspense fallback={<QueueHealthSkeleton />}>
        <QueueHealth />
      </Suspense>
      <Suspense fallback={<HistorySkeleton />}>
        <BroadcastHistory page={1} />
      </Suspense>
    </>
  );
}
```

---

## 11. Live progress without SSE

The SSE progress stream described in the PID **does not exist yet** (see §13). Until it does, poll `GET /api/reminders/:id` — a broadcast runs for ~40 minutes, so a 2–3 second poll is both sufficient and cheap.

Because the admin API is server-side only, expose a **same-origin Route Handler** for the client to poll. It reuses the server client, so the token never leaves the server:

```ts
// app/api/reminders/[id]/progress/route.ts
import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api/client';
import type { ReminderProgress } from '@/lib/api/types';

// params is a Promise in Next 16.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const data = await api<ReminderProgress>(`/reminders/${id}`);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
```

```tsx
// app/(dashboard)/reminders/[id]/progress-view.tsx
'use client';
import { useEffect, useState } from 'react';
import type { ReminderProgress } from '@/lib/api/types';

const LIVE = new Set(['PENDING', 'PROCESSING']);

export function ProgressView({ initial }: { initial: ReminderProgress }) {
  const [progress, setProgress] = useState(initial);

  useEffect(() => {
    if (!LIVE.has(progress.status)) return; // stop polling once terminal

    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/reminders/${progress.id}/progress`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.ok) setProgress(await res.json());
      } catch {
        /* transient — the next tick retries */
      }
    }, 3000);

    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [progress.id, progress.status]);

  const done = progress.delivered + progress.dmClosed + progress.failed;
  const pct = progress.targetCount
    ? Math.round((done / progress.targetCount) * 100)
    : 0;

  return (
    <div>
      <progress
        value={done}
        max={progress.targetCount}
        aria-label="Delivery progress"
      />
      <p>
        {done} of {progress.targetCount} processed ({pct}%)
      </p>
      <dl>
        <dt>Delivered</dt>
        <dd>{progress.delivered}</dd>
        <dt>DMs closed (mentioned in channel)</dt>
        <dd>{progress.dmClosed}</dd>
        <dt>Failed</dt>
        <dd>{progress.failed}</dd>
        <dt>
          {progress.status === 'CANCELLED' ? 'Never attempted' : 'Remaining'}
        </dt>
        <dd>{progress.outstanding}</dd>
      </dl>
    </div>
  );
}
```

Render the page server-side first and pass the result as `initial`, so there's no empty flash:

```tsx
// app/(dashboard)/reminders/[id]/page.tsx
import { api } from '@/lib/api/client';
import type { ReminderProgress } from '@/lib/api/types';
import { ProgressView } from './progress-view';

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const progress = await api<ReminderProgress>(`/reminders/${id}`);
  return <ProgressView initial={progress} />;
}
```

Show a "~N minutes remaining" estimate from `outstanding / dmPerSecond` (from `GET /reminders/status`) — 40 minutes of a bar that barely moves reads as broken otherwise, when it is the rate limiter working as designed.

---

## 12. The public attendance form (separate app)

Different deployment, different origin (`ATTENDANCE_FORM_URL`), **no auth at all**. This is the one place browser-direct calls to the backend are correct: `verify-user` and `verify-email` both fire on a keystroke debounce, and routing every keystroke through the Next server would double the latency for no security gain (both endpoints are public by design).

Use `NEXT_PUBLIC_API_BASE_URL` here, and make sure the form's origin is in the backend's `ATTENDANCE_FORM_URL`.

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import type { ApiResponse, VerifyUserPayload } from '@/lib/api/types';

const API = process.env.NEXT_PUBLIC_API_BASE_URL!;
// Must match the backend regex exactly — do NOT forbid a leading/trailing _ or .
const HANDLE = /^(?!.*\.{2})[a-z0-9_.]{2,32}$/;
const normalize = (raw: string) => raw.trim().replace(/^@+/, '').toLowerCase();

type Badge =
  | { kind: 'idle' | 'checking' | 'malformed' | 'error' }
  | { kind: 'verified'; payload: VerifyUserPayload }
  | { kind: 'unknown' }
  | { kind: 'duplicate'; date: string };

export function DiscordHandleField() {
  const [value, setValue] = useState('');
  const [badge, setBadge] = useState<Badge>({ kind: 'idle' });
  const abort = useRef<AbortController>(null);

  useEffect(() => {
    const handle = normalize(value);

    if (!handle) {
      setBadge({ kind: 'idle' });
      return;
    }
    if (!HANDLE.test(handle)) {
      setBadge({ kind: 'malformed' });
      return;
    }

    setBadge({ kind: 'checking' });

    // 500 ms debounce keeps a typing student well inside the 60/min budget.
    const timer = setTimeout(async () => {
      abort.current?.abort();
      abort.current = new AbortController();

      try {
        const res = await fetch(
          `${API}/attendance/verify-user?username=${encodeURIComponent(handle)}`,
          { signal: abort.current.signal },
        );
        if (res.status === 429) {
          setBadge({ kind: 'error' });
          return;
        }

        const json = (await res.json()) as ApiResponse<VerifyUserPayload>;
        // Branch on data.verified — an unknown handle is still HTTP 200.
        if (!json.data?.verified) {
          setBadge({ kind: 'unknown' });
          return;
        }
        setBadge(
          json.data.alreadySubmitted
            ? { kind: 'duplicate', date: json.data.attendanceDate }
            : { kind: 'verified', payload: json.data },
        );
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setBadge({ kind: 'error' });
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      abort.current?.abort();
    };
  }, [value]);

  return (
    <div>
      <label htmlFor="discordUsername">Discord username</label>
      <input
        id="discordUsername"
        name="discordUsername"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby="handle-status"
      />
      <p id="handle-status" role="status" aria-live="polite">
        {badge.kind === 'checking' && 'Checking…'}
        {badge.kind === 'malformed' &&
          'Use the name under the @ on your Discord profile — lowercase letters, numbers, _ or . only.'}
        {badge.kind === 'unknown' &&
          'We could not find that username in our Discord server. Check the spelling, or join the server first.'}
        {badge.kind === 'duplicate' &&
          `You already submitted your attendance for ${badge.date}.`}
        {badge.kind === 'verified' &&
          `✅ ${badge.payload.member!.displayName ?? badge.payload.member!.discordUsername}`}
        {badge.kind === 'error' &&
          'Could not verify right now — you can still submit.'}
      </p>
    </div>
  );
}
```

The email field uses the same live-badge pattern, against the new `verify-email` endpoint. Read `emailVerificationRequired` from `/window` on mount and skip the badge entirely when the gate is OFF.

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import type { ApiResponse, VerifyEmailPayload } from '@/lib/api/types';

const API = process.env.NEXT_PUBLIC_API_BASE_URL!;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Badge =
  | { kind: 'idle' | 'checking' | 'malformed' | 'error' | 'notRequired' }
  | { kind: 'verified' }
  | { kind: 'unknown'; message: string };

export function EmailField() {
  const [value, setValue] = useState('');
  const [badge, setBadge] = useState<Badge>({ kind: 'idle' });
  const abort = useRef<AbortController>(null);

  useEffect(() => {
    const address = value.trim();

    if (!address) {
      setBadge({ kind: 'idle' });
      return;
    }
    if (!EMAIL.test(address)) {
      setBadge({ kind: 'malformed' });
      return;
    }

    setBadge({ kind: 'checking' });

    const timer = setTimeout(async () => {
      abort.current?.abort();
      abort.current = new AbortController();

      try {
        const res = await fetch(
          `${API}/attendance/verify-email?email=${encodeURIComponent(address)}`,
          { signal: abort.current.signal },
        );
        if (res.status === 429) {
          setBadge({ kind: 'error' });
          return;
        }

        const json = (await res.json()) as ApiResponse<VerifyEmailPayload>;
        // Same rule as the handle field: branch on data.verified, never on the
        // HTTP status. An unrecognised address is still HTTP 200.
        if (!json.data?.verified) {
          // Show the backend's own message as the hint - that copy is what the
          // student will also see at submit time, so they learn the rule here.
          // When the gate is OFF the backend also answers `verified: false`,
          // with a "roster check is currently disabled" message, so this same
          // branch renders the gate-off state without a ✅ badge.
          setBadge({ kind: 'unknown', message: json.message });
          return;
        }
        // `verified` is true here, which means the address IS on the roster
        // AND the gate is currently armed. Render the verified badge.
        if (!json.data.emailVerificationRequired) {
          // Unreachable with the current contract - `verified: true` requires
          // the gate to be armed. Left as a defensive check; if the backend
          // contract is ever relaxed again, this keeps the form from showing
          // a ✅ on an unenrolled address.
          setBadge({ kind: 'notRequired' });
          return;
        }
        setBadge({ kind: 'verified' });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setBadge({ kind: 'error' });
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      abort.current?.abort();
    };
  }, [value]);

  return (
    <div>
      <label htmlFor="email">Email address</label>
      <input
        id="email"
        name="email"
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby="email-status"
      />
      <p id="email-status" role="status" aria-live="polite">
        {badge.kind === 'checking' && 'Checking…'}
        {badge.kind === 'malformed' &&
          'Enter a valid email address.'}
        {badge.kind === 'unknown' && badge.message}
        {badge.kind === 'verified' && '✅ Enrolled email address'}
        {badge.kind === 'notRequired' && ''}
        {badge.kind === 'error' &&
          'Could not verify right now — you can still submit.'}
      </p>
    </div>
  );
}
```

Form rules worth encoding:

- **Verification is a UI affordance, not a gate.** If either verify fails for a network reason, still let the student submit — `POST /submit` re-runs every check server-side and is the real enforcement point.
- Handle the submit 409 (already submitted) as a **success-adjacent** state, not a red error: the student's attendance is recorded.
- Handle the submit 404 as "you're not in the Discord server (any more)", distinct from the 400 "check what you typed".
- Handle the submit 403 as "use the email you enrolled with" — distinct from both the 404 (handle) and the 400 (malformed). All three check different fields.
- Skip the email-field badge entirely when `emailVerificationRequired` is `false` — the gate is off, so there is nothing to verify, and showing "✅ enrolled" on every address is misleading.
- Show a phone-format hint (`01711000000`), and accept `+880`/`880` prefixes without rewriting what the student typed.
- Don't block non-Latin names — `name` accepts any Unicode letters.

---

## 13. Not implemented yet

Nothing below exists on the backend today. Do not build a frontend against these paths — they will 404 with `API Not Found!`.

- **The SSE progress stream** that would wrap the reminder progress read. Poll `GET /api/reminders/:id` instead (§11).
- **Admin user management** (create/list/suspend admins). Admins are seeded via `bun run seed`.
- **XLSX export format** (`GET /api/daily-status/export?format=xlsx` returns 501 Not Implemented; use `format=csv`).

---

## 14. Gotcha checklist

Print this next to the monitor.

- [ ] `Authorization: <token>` — **no `Bearer ` prefix**.
- [ ] An expired access token returns **HTTP 500** with `message: "jwt expired"`, not 401. Treat both as "refresh".
- [ ] The backend's own auth cookies (`secure:false` + `sameSite:'none'`) are rejected by browsers. Read tokens from the response **body** and set your own cookies from the Next server.
- [ ] `POST /auth/refresh-token` reads the token from a **cookie header**, not the body — and it **rotates**, so never fire two concurrently.
- [ ] Refresh tokens die after **7 days** (DB row), whatever `JWT_REFRESH_EXPIRES_IN` says.
- [ ] Login with an unknown email is a **404**, not a 401. Show one generic message for both.
- [ ] The payload is always under `data`. Flags like `verified` are `data.verified`.
- [ ] Zod error messages arrive **Title Cased**. Map `errorDetails.issues[].path` to your own copy.
- [ ] Error bodies have no `statusCode` field, and the useful text is sometimes in `errorMessage` rather than `message`.
- [ ] `GET /attendance/verify-user` answers **200 for an unknown handle**; `POST /submit` answers **404**. Branch on `data.verified`, not the status code.
- [ ] `GET /attendance/verify-email` answers **200 for an unrecognised address**; `POST /submit` answers **403** when the gate is armed. Same envelope as `/verify-user` — branch on `data.verified`, never on the status code.
- [ ] `POST /submit` answers **403** when the email is not on the enrolment roster and **404** when the Discord handle is in no server. Different fields, different messages — do not collapse them.
- [ ] Read **`emailVerificationRequired`** from `GET /attendance/window` (and from `/attendance/verify-email`'s response) on form mount and label the email field before the student fills the form. When it is `false`, skip the email badge entirely — there is nothing to verify and showing "✅ enrolled" on every address is misleading.
- [ ] Never derive `YYYY-MM-DD` with `toISOString()` — use the Asia/Dhaka `Intl` helper (§5).
- [ ] `date` on `POST /reminders/send` is **required and never inferred**. Always show the `/targets` preview and a confirmation first.
- [ ] The reminder message cap is **1970** characters, not 2000.
- [ ] `POST /reminders/send` and `POST /discord/sync` return **202** — the work hasn't happened yet. Poll.
- [ ] `PATCH /schedule/daily-update` rejects an empty body, rejects `openTime` outright (it follows the announcement time), and validates `closeTime > openTime` against the stored open time — mirror those checks client-side.
- [ ] Never expose a cron input for the schedule; times + weekday checkboxes only.
- [ ] `POST /schedule/daily-update/open|lock` posts an announcement embed to a channel thousands of students read. Confirm first.
- [ ] Bind the announcement editor to `template.body` (placeholders intact), **never** to `preview.content` — a round-trip would bake today's date into the stored message.
- [ ] Drive the announcement character counter from `preview.length`, not `body.length`: the 2,000 limit is checked on the **rendered** message plus the mention line.
- [ ] `mentionEveryone: true` pings the whole guild every evening until turned off. Confirm explicitly and show it on the read screen; a literal `@everyone` typed into the body is inert.
- [ ] `POST /announcement/attendance/send` is a mass mention and irreversible. Second send today is a **409**; `{ "force": true }` is the only way past it. It also opens `#daily-update` — surface `data.channel.failed` and a `null` `data.channel.locksAt`.
- [ ] Don't offer a close-time field on the announcement screen — `{{close_time}}` is read from the `#daily-update` schedule so the two can never disagree.
- [ ] The announcement has **no boot reconcile**: if `today.posted` is false after `nextRunAt` passed, that day needs a manual send.
- [ ] Debounce `verify-user` and `verify-email` at 500 ms and abort stale requests — both have a 60/min per IP budget.
- [ ] Don't auto-retry `POST /submit` — 5 per 15 min per IP is the entire budget.
- [ ] Surface `dailyUpdate.ingestionEnabled === false`, `lastSync.guardTripped`, `scheduler.lastRun.error`, `lastFallback.missingPermission`, and the announcement's `scheduler.lastOutcome` — each is an otherwise-invisible outage.
- [ ] `DM_CLOSED` is not a failure; label it "DMs closed — mentioned in channel".
- [ ] `today.posted` on the announcement is `true` only when **every** server posted. Always inspect `today.servers[]`; a single green flag hides a silent server.
- [ ] Fan-out endpoints (`POST /discord/sync`, `POST /schedule/daily-update/open|lock`, `POST /announcement/attendance/send`, `POST /reminders/send`) accept `{ guildId }` or `{ guildIds: [] }` to scope the work to a subset of servers. Omit to target every configured one.
- [ ] Fan-out is partial-success-200. `data.summary` (or `data.*` shaped envelope) carries per-server outcomes — a single green flag is not a sign of total success.
- [ ] Multi-guild endpoints that **return** a `servers[]` or `byServer[]` array are memberships, not people; they do **not** sum to the top-level totals when anyone is in two servers.
- [ ] Daily-status range mode is `from`+`to` XOR `date`. Send only one, or the schema rejects it.
- [ ] Range mode filtering is its own filter set: `rangeStatus` (`ALL_COMPLETE`/`PARTIAL`/`NONE`) and `minMissedBothDays` are range-only; `status` (`COMPLETE`/`MISSING_*`) is date-only. Sending the wrong one for the active mode is a 400.
- [ ] Range mode sorting is its own sort set: `name` | `missedBothDays` | `completeDays` | `rangeStatus`. Date mode has no `sortBy`/`sortDir`.
- [ ] `incompleteDays` and `missedBothDays` are different numbers. The reminder threshold acts on `missedBothDays` — never read from `incompleteDays` when choosing a threshold.
- [ ] Roster engagement totals do **not** equal dashboard daily-status totals — the roster only includes enrolled students who paired a Discord account; unpaired enrollees show as `NEVER_LINKED` on `/roster/status/*` and never appear on `/api/daily-status*`.
- [ ] Range spans are capped at 92 days in §5A. Pick a narrower `daysOfWeek` or shorter `from`/`to` rather than widening past it.
- [ ] `format=xlsx` on `/api/daily-status/export` (any mode) and on `/api/roster/status/export` returns 501 Not Implemented. Use `format=csv` (the default).
- [ ] `/api/reminders/targets` and `/api/reminders/send` take a `criterion` (`missedBothDays` | `missedUpdateDays` | `missedAttendanceDays` | `neverPosted` | `neverAttended`) with optional `minMissedDays` and range `daysOfWeek` — the date-only `reminderDate` shape is gone.
- [ ] `GET /api/reminders/:id/recipients` is paginated by default (50/page). Use `meta.total` for the count, not `data.length`.
- [ ] `/api/roster/status/*` periods and `?status=NEVER_LINKED` are the only way to find people whose Discord account never linked. They never appear in `/api/daily-status` because there is no member record to attribute their attendance to.
- [ ] A `CANCELLED` broadcast's `outstanding` recipients were **never attempted**, not failed.
