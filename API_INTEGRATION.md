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

`GET /api/attendance/window` is **unchanged** — one shared schedule means one window, so it takes no server parameter.

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
  bot: { connected: boolean; tag: string | null; guildId: string | null };
  members: { total: number; active: number; departed: number };
  lastSync: SyncState;
  dailyUpdate: {
    ingestionEnabled: boolean;
    reason: string | null;
    channelId: string | null;
  };
};

export type SyncTriggerResult = {
  accepted: true;
  guildId: string;
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
    openTime: string; // "HH:mm"
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
  channel: { id: string | null; isOpen: boolean };
};

export type ChannelToggleResult = {
  channelId: string | null;
  isOpen: boolean;
  announced: boolean;
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
  attempt: number;
  discordMessageId: string;
  unresolvedTargets: string[];
  channelId: string | null;
};

// ── Reminders ───────────────────────────────────────────────────────────
export type ReminderStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export type ReminderDeliveryStatus =
  'PENDING' | 'DELIVERED' | 'DM_CLOSED' | 'FAILED';

export type ReminderTarget = {
  memberId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
};

export type ReminderTargetsPayload = {
  date: string;
  targetCount: number;
  targets: ReminderTarget[];
};

export type ReminderQueued = {
  id: string;
  reminderDate: string;
  targetCount: number;
  queuedJobs: number;
  status: ReminderStatus;
};

export type ReminderProgress = {
  id: string;
  reminderDate: string;
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
  reminderDate: string;
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

#### 🔐 `GET /api/discord/sync/status`

No parameters.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Discord sync status retrieved successfully",
  "data": {
    "bot": {
      "connected": true,
      "tag": "DailyBot#1234",
      "guildId": "1234567890123456789",
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
  },
}
```

**Surface these three things prominently — they are otherwise invisible failures:**

- `dailyUpdate.ingestionEnabled === false` → the bot fell back to a login without the Message Content intent. Every message is arriving empty, so **no daily updates are being recorded** and the dashboard will show everyone as `MISSING_UPDATE`. Show `reason` and link to the Developer Portal fix.
- `lastSync.guardTripped === true` → the departure guard skipped a reconcile because a member fetch came back suspiciously small. The directory is stale but intact; this is the guard working, not a bug. Warn, don't alarm.
- `bot.connected === false` → sync, ingestion, the scheduler's channel edits, and reminder DMs are all down. The REST API keeps serving.

#### 🔐 `POST /api/discord/sync`

No body. Fires a full guild re-sync **without awaiting it** — a real sync takes tens of seconds.

**202**

```jsonc
{
  "success": true,
  "statusCode": 202,
  "message": "Member sync started",
  "data": {
    "accepted": true,
    "guildId": "…",
    "startedAt": "2026-08-17T09:20:00.000Z",
  },
}
```

| Status | Cause                                                |
| ------ | ---------------------------------------------------- |
| 409    | a sync is already running                            |
| 503    | bot not connected, or the guild could not be fetched |

Because the response returns before the work does, poll `GET /sync/status` until `lastSync.running` flips to `false`:

```ts
'use server';
import { revalidateTag } from 'next/cache';
import { api } from '@/lib/api/client';
import type { SyncTriggerResult } from '@/lib/api/types';

export async function triggerMemberSync() {
  const result = await api<SyncTriggerResult>('/discord/sync', {
    method: 'POST',
  });
  revalidateTag('discord-status');
  return result; // the client then polls until lastSync.running === false
}
```

---

### 8.4 Schedule — `/api/schedule`

All routes 🔐. This governs when ~5,000 students may post in `#daily-update`.

#### 🔐 `GET /api/schedule/daily-update`

No parameters. The row is created lazily with PID defaults (18:00 / 23:59 / all seven days / enabled) on first read, so this never 404s.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Channel schedule retrieved successfully",
  "data": {
    "schedule": {
      "openTime": "18:00",
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
  },
}
```

- `channel.isOpen` is read **live from Discord** on every request (an admin can flip the overwrite by hand), so this endpoint always costs a Discord API call — never cache it.
- **`scheduler.lastRun.error` is where a missing `Manage Roles` permission shows up.** If the channel stops opening, check here first; `DiscordAPIError[50013]` means the bot lacks the permission on the channel.
- `scheduler.processEnabled === false` means `SCHEDULER_ENABLED=false` on this process — the timed jobs are off, but the manual open/lock endpoints still work.
- `nextOpenAt`/`nextLockAt` are `null` when no task is registered (disabled schedule, or a process that isn't scheduling).

#### 🔐 `PATCH /api/schedule/daily-update`

**Body** — a patch; every field optional, but **an empty object is rejected (400)**.

| Field        | Type     | Rules                                           |
| ------------ | -------- | ----------------------------------------------- |
| `openTime`   | string   | 24-hour `HH:mm`, `00:00`–`23:59`                |
| `closeTime`  | string   | same                                            |
| `daysOfWeek` | number[] | ≥ 1 entry, each 0–6 (0 = Sunday), no duplicates |
| `enabled`    | boolean  | —                                               |

Do **not** send `timezone` — Zod strips it silently; the zone is fixed.

**Cross-field rule (a 400 from the service, not from Zod):** `closeTime` must be strictly greater than `openTime` **after merging with the stored row**. Sending `{ "closeTime": "02:00" }` against a stored `openTime` of `18:00` is a 400 with a long explanatory message. Mirror this check in the form before submitting, using the currently-loaded schedule as the merge base.

**200** → the same payload shape as `GET`, already reflecting the change (the scheduler is reloaded in-process; no restart needed).

```ts
// actions/schedule.ts
'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { ChannelSchedulePayload } from '@/lib/api/types';

export async function updateSchedule(input: {
  openTime?: string;
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

No body. Forces the channel state **now** and posts an announcement embed to the channel (`announce: true`). The stored schedule is untouched, so the next scheduled transition still fires.

**200** → `data: { channelId, isOpen, announced }`

| Status | Cause                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- |
| 403    | the bot lacks `Manage Roles` on the channel — message tells the admin exactly what to grant |
| 503    | the bot is not connected, or the permission edit failed for another reason                  |

These are **outward-facing and immediately visible to thousands of students** (they post an embed). Put them behind a confirmation dialog.

---

### 8.5 Reminders — `/api/reminders`

All routes 🔐. `POST /send` DMs thousands of people and **cannot be undone**.

> **Route order matters on the backend**: `/targets` and `/status` are declared before `/:id`. Don't invent an id-shaped path that collides with them.

#### 🔐 `GET /api/reminders/targets?date=YYYY-MM-DD`

The dry run. Sends nothing.

| Query  | Type   | Rules                                                                   |
| ------ | ------ | ----------------------------------------------------------------------- |
| `date` | string | **required**, `YYYY-MM-DD`, a real calendar date, **not in the future** |

**200** → `data: { date, targetCount, targets: ReminderTarget[] }`

The list is **not paginated** — for a 5,000-member guild with a bad day this can be thousands of rows. Render it virtualized, or show `targetCount` plus a preview slice.

The target definition is "currently in the guild **and** has no `daily_updates` row for that date". It is the exact same query `POST /send` uses, so the preview cannot disagree with the send.

#### 🔐 `POST /api/reminders/send`

**Body**

| Field     | Type   | Rules                                                         |
| --------- | ------ | ------------------------------------------------------------- |
| `date`    | string | **required, never inferred**, `YYYY-MM-DD`, not in the future |
| `message` | string | trimmed, 1–**1970** characters                                |

The 1970 cap = Discord's 2000-character limit minus the fixed heading `⚠️ **Daily Update Reminder**` the DM is wrapped in. Enforce it in the textarea with a live counter so the admin never discovers it at submit time.

**202**

```jsonc
{
  "success": true,
  "statusCode": 202,
  "message": "Reminder broadcast queued for 412 member(s). Delivery is paced and runs in the background.",
  "data": {
    "id": "…",
    "reminderDate": "2026-08-16",
    "targetCount": 412,
    "queuedJobs": 412,
    "status": "PENDING",
  },
}
```

**Nothing has been delivered when this returns.** Delivery is paced at `REMINDER_DM_PER_SECOND` (default 2/sec) — ~5,000 members is ~40 minutes. That pacing is deliberate: bursting DMs gets the bot banned, and the bot shares a process with member sync and the attendance form's membership check.

| Status | Cause                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 400    | Zod, or **every member already submitted** — "There is nobody to remind."                                               |
| 409    | a broadcast for that date is already `PENDING`/`PROCESSING` (double-click guard) — the message includes the existing id |
| 503    | Redis unreachable, or the queue refused the jobs (the broadcast is auto-cancelled so the date isn't left blocked)       |

**Always run the `/targets` preview first and make the admin confirm the count.** Then redirect to the progress page:

```ts
// actions/reminders.ts
'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api/client';
import type { ReminderQueued } from '@/lib/api/types';

export async function sendReminder(input: { date: string; message: string }) {
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
      "reminderDate": "2026-08-16",
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

#### 🔐 `GET /api/reminders/:id` (live progress)

**200**

```jsonc
{
  "data": {
    "id": "…",
    "reminderDate": "2026-08-16",
    "message": "…",
    "status": "PROCESSING",
    "targetCount": 412,
    "delivered": 201,
    "dmClosed": 12,
    "failed": 3,
    "outstanding": 196,
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

🔓 **The only three routes in the application with no `auth()` middleware.** Students are not `users` rows, so there is no credential the form could present. What replaces authentication:

1. For `/verify-user` and `/submit`: the handle must resolve to a member with `isInGuild: true`.
2. Per-IP rate limits (§9).

Both membership checks re-run on the write path — `submit` never trusts that `verify-user` was called. `/window` exposes only the schedule submission window (no member data) and is rate limited.

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
    "openTime": "18:00", // HH:mm, Asia/Dhaka
    "closeTime": "23:59", // HH:mm, Asia/Dhaka
    "daysOfWeek": [0, 1, 2, 3, 4, 5, 6], // 0=Sunday..6=Saturday
    "enabled": true, // false = paused (window never opens)
    "timezone": "Asia/Dhaka", // reported timezone constant
    "nextOpenAt": "2026-08-19T12:00:00.000Z", // next future opening instant (null when enabled: false)
    "closesAt": "2026-08-18T17:59:00.000Z", // closing instant for currently open window (null when isOpen: false)
  },
}
```

- **`nextOpenAt`** is reported even while the window is currently open (naming the _next_ occurrence). It is `null` only when `enabled` is `false`.
- **`closesAt`** is populated only when `isOpen` is `true`; otherwise it is `null`.
- The response carries **no admin-shaped fields**: no `updatedBy`, no `scheduler`, no `lastRun`, and no Discord channel or guild ID.

#### 🔓 `GET /api/attendance/verify-user?username=…`

| Query      | Type   | Rules                                                                                                                                |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `username` | string | required, trimmed, non-empty, must pass `/^(?!.*\.{2})[a-z0-9_.]{2,32}$/` after normalization (trim → strip leading `@` → lowercase) |

A leading or trailing `_` or `.` is **valid** (`.rabbil`, `itzazad_`). Don't tighten this client-side — an earlier stricter regex locked out 5.3% of real members.

**Always 200**, even when the handle is unknown — "not found" is a routine answer on the read path, and the form has to render something either way.

```jsonc
// verified, hasn't submitted
{
  "success": true, "statusCode": 200,
  "message": "Discord username verified",
  "data": {
    "verified": true, "alreadySubmitted": false,
    "attendanceDate": "2026-08-17",
    "member": {
      "id": "…", "discordUserId": "…", "discordUsername": "rakib_",
      "displayName": "Rakib", "avatarUrl": "https://cdn.discordapp.com/…"
    }
  }
}

// not a member (still HTTP 200!)
{
  "success": true, "statusCode": 200,
  "message": "This Discord username was not found in our Discord server. Please check the username, or join the server first.",
  "data": { "verified": false, "alreadySubmitted": false, "attendanceDate": "2026-08-17", "member": null }
}
```

**Branch on `data.verified`, never on the HTTP status.** `member` is always `null` when `verified` is `false` — no partial disclosure.

A malformed handle is a **400** (Zod). The form must tell "fix your typing" (400) apart from "you're not in the server" (200 + `verified: false`).

#### 🔓 `POST /api/attendance/submit`

**Body** — exactly these four fields; anything else is stripped.

| Field             | Type   | Rules                                                                                       |
| ----------------- | ------ | ------------------------------------------------------------------------------------------- |
| `name`            | string | trimmed, 3–100 chars, `^[\p{L}\s]+$` — **Unicode letters**, so Bengali names are accepted   |
| `phone`           | string | trimmed, `^(?:\+?880\|0)1[3-9]\d{8}$` — `01711000000`, `+8801711000000`, or `8801711000000` |
| `email`           | string | valid email                                                                                 |
| `discordUsername` | string | same rule as `verify-user`                                                                  |

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
  },
}
```

| Status  | Cause                                           | Notes                                                                                        |
| ------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400     | Zod                                             | field-level; map `errorDetails.issues` to inputs                                             |
| **404** | handle unknown or the member has left the guild | on the **write** path not-found is a genuine failure, unlike `verify-user`                   |
| 409     | already submitted today                         | message names the date: `You have already submitted your attendance for today (2026-08-17).` |
| 429     | rate limit                                      | 5 per 15 min per IP                                                                          |

The 409 is enforced by a database unique constraint (`(memberId, attendanceDate)`), not a read-then-write check — two simultaneous submissions still produce exactly one row.

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
    "today": { "date": "2026-08-18", "posted": false, "attempts": [] },
  },
}
```

- **`template.body` is the raw text with placeholders unexpanded — that is what the editor binds to.** `preview.content` is the same body rendered against today's live values plus the mention line, i.e. exactly what students would read. Never show `preview.content` in an editable field; a round-trip would bake today's date into the stored template.
- **`preview.closeTime` is read from the `#daily-update` schedule** (§8.4), not stored here. Changing the close time there changes this message without anyone editing it. That is the whole point — don't offer a close-time field on this screen.
- `today.posted` and `today.attempts` are how you show "sent today ✓". An attempt stuck in `SENDING` means a crash between the claim and the post; a forced send (below) recovers it.
- **`scheduler.lastOutcome` is where a missing `Send Messages` permission shows up.** Surface it — the only other symptom is a channel that quietly stops being announced in.
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

**200** → the same payload shape as `GET`, already reflecting the change. Changing `announceTime`, `daysOfWeek`, or `enabled` rebuilds the cron task in-process; no restart needed. A reload failure does **not** fail the request (the row is saved) — it surfaces under `scheduler` on the next read.

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

**Body** — `{ force?: boolean }` (defaults to `false`).

Posts **immediately**, leaving the stored schedule untouched. Works on every process, including one where `SCHEDULER_ENABLED=false`.

**200** → `data: AnnouncementSendResult`.

| Status | Cause                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------- |
| 409    | today is already posted — the message names the earlier post's time and attempt                    |
| 403    | the bot lacks `Send Messages` on the attendance channel — the failure does **not** consume the day |
| 503    | the bot is not connected, or Discord refused the message for another reason                        |

- **At most one post per Dhaka day**, enforced by a database claim rather than by timing — a double-clicked button gets the 409, not a second message. `{ "force": true }` is the only way to post twice in one day and files the second one as the next `attempt`.
- **A failed send does not consume the day.** After fixing a permission, retry plainly; no `force` needed.
- This is **outward-facing and irreversible** — potentially a mass mention to thousands of students. Put it behind a confirmation dialog that shows `preview.content` and, when `mentionEveryone` is on, says so explicitly.

---

### 8.8 Daily status — `/api/daily-status`

All routes 🔐. These endpoints feed the admin daily status dashboard, member status table, member history dialog, and CSV export.

#### 🔐 `GET /api/daily-status/counts?date=YYYY-MM-DD`

Summary overview figures for a given Asia/Dhaka civil date.

| Query  | Type   | Rules                                           |
| ------ | ------ | ----------------------------------------------- |
| `date` | string | **required**, `YYYY-MM-DD`, valid calendar date |

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Daily status counts retrieved successfully",
  "data": {
    "date": "2026-08-18",
    "totalMembers": 5187,
    "attendanceSubmitted": 4320,
    "dailyUpdateSubmitted": 3000,
    "bothComplete": 2800,
    "missingUpdateOnly": 1520,
    "missingAttendanceOnly": 200,
    "missingBoth": 667,
  },
}
```

- Every count is guaranteed to be a JSON **number**, not a bigint.
- Invariant: `bothComplete + missingUpdateOnly + missingAttendanceOnly + missingBoth === totalMembers`.
- **Past dates work.** The frontend 7-day trend chart calls this endpoint 7 times in parallel for historical days.

#### 🔐 `GET /api/daily-status?date=YYYY-MM-DD&page=1&limit=50&status=&search=`

Paginated list of active guild members and their attendance/daily update status for a given date.

| Query    | Type   | Rules                                                                                 |
| -------- | ------ | ------------------------------------------------------------------------------------- |
| `date`   | string | **required**, `YYYY-MM-DD`, valid calendar date                                       |
| `page`   | number | optional, integer ≥ 1, default `1`                                                    |
| `limit`  | number | optional, integer 1–200, default `50`                                                 |
| `status` | enum   | optional: `COMPLETE` \| `MISSING_UPDATE` \| `MISSING_ATTENDANCE` \| `MISSING_BOTH`    |
| `search` | string | optional, case-insensitive partial search on name, phone, email, or `discordUsername` |

`status` and `search` combine (AND), applied before pagination.

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Daily status retrieved successfully",
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 1520,
  },
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
    },
  ],
}
```

- `meta.total` is the **filtered** row count (matching the active search/status filters), driving the UI pager.

#### 🔐 `GET /api/daily-status/members/:memberId?date=YYYY-MM-DD`

Detailed status for a specific member on a given date, including their posted `#daily-update` messages.

| Param      | Type   | Rules                                           |
| ---------- | ------ | ----------------------------------------------- |
| `memberId` | string | **required**, member CUID/ID                    |
| `date`     | string | **required**, `YYYY-MM-DD`, valid calendar date |

**200**

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Member daily status retrieved successfully",
  "data": {
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
    "messages": [
      {
        "id": "cmupdate123",
        "content": "Today I implemented the public window endpoint.",
        "postedAt": "2026-08-18T18:40:12.000Z",
      },
    ],
  },
}
```

- `messages: []` when no messages were posted on that date.
- **404** if `memberId` is not found.

#### 🔐 `GET /api/daily-status/export?date=YYYY-MM-DD&status=&search=&format=csv`

Exports filtered daily status rows as a direct file attachment.

| Query    | Type   | Rules                                           |
| -------- | ------ | ----------------------------------------------- |
| `date`   | string | **required**, `YYYY-MM-DD`, valid calendar date |
| `status` | enum   | optional, same filter as table                  |
| `search` | string | optional, same search as table                  |
| `format` | string | optional, `csv` (default)                       |

**200** (File attachment)

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="daily-status-2026-08-18.csv"
```

- Streams batches of rows to support exporting thousands of members without memory exhaustion.
- Escapes spreadsheet formula injection by prepending `'` to values starting with `=`, `+`, `-`, or `@`.

---

### 8.9 Root

`GET /` → `Hello, World!` (plain text, not the envelope). Usable as a liveness probe. There is **no** `/api/health` endpoint.

---

## 9. Rate limits

| Endpoint                          | Budget | Window | Applies to |
| --------------------------------- | ------ | ------ | ---------- |
| `GET /api/attendance/window`      | 60     | 1 min  | per IP     |
| `GET /api/attendance/verify-user` | 60     | 1 min  | per IP     |
| `POST /api/attendance/submit`     | 5      | 15 min | per IP     |

Everything else is unlimited but admin-only.

429 responses use the **normal `sendResponse` envelope** (`success: false`, `data: null`) plus standard `RateLimit-*` headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`). Read `RateLimit-Reset` to show "try again in N seconds".

Frontend implications:

- Debounce `verify-user` at **500 ms** minimum. 60/min covers a student typing, backspacing, and retrying — but a per-keystroke call will exhaust it.
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

Different deployment, different origin (`ATTENDANCE_FORM_URL`), **no auth at all**. This is the one place browser-direct calls to the backend are correct: `verify-user` fires on a keystroke debounce, and routing every keystroke through the Next server would double the latency for no security gain (the endpoint is public by design).

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

Form rules worth encoding:

- **Verification is a UI affordance, not a gate.** If verify fails for a network reason, still let the student submit — `POST /submit` re-runs every check server-side and is the real enforcement point.
- Handle the submit 409 (already submitted) as a **success-adjacent** state, not a red error: the student's attendance is recorded.
- Handle the submit 404 as "you're not in the Discord server (any more)", distinct from the 400 "check what you typed".
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
- [ ] Never derive `YYYY-MM-DD` with `toISOString()` — use the Asia/Dhaka `Intl` helper (§5).
- [ ] `date` on `POST /reminders/send` is **required and never inferred**. Always show the `/targets` preview and a confirmation first.
- [ ] The reminder message cap is **1970** characters, not 2000.
- [ ] `POST /reminders/send` and `POST /discord/sync` return **202** — the work hasn't happened yet. Poll.
- [ ] `PATCH /schedule/daily-update` rejects an empty body, and validates `closeTime > openTime` against the **merged** result — mirror that check client-side.
- [ ] Never expose a cron input for the schedule; times + weekday checkboxes only.
- [ ] `POST /schedule/daily-update/open|lock` posts an announcement embed to a channel thousands of students read. Confirm first.
- [ ] Bind the announcement editor to `template.body` (placeholders intact), **never** to `preview.content` — a round-trip would bake today's date into the stored message.
- [ ] Drive the announcement character counter from `preview.length`, not `body.length`: the 2,000 limit is checked on the **rendered** message plus the mention line.
- [ ] `mentionEveryone: true` pings the whole guild every evening until turned off. Confirm explicitly and show it on the read screen; a literal `@everyone` typed into the body is inert.
- [ ] `POST /announcement/attendance/send` is a mass mention and irreversible. Second send today is a **409**; `{ "force": true }` is the only way past it.
- [ ] Don't offer a close-time field on the announcement screen — `{{close_time}}` is read from the `#daily-update` schedule so the two can never disagree.
- [ ] The announcement has **no boot reconcile**: if `today.posted` is false after `nextRunAt` passed, that day needs a manual send.
- [ ] Debounce `verify-user` at 500 ms and abort stale requests — the budget is 60/min per IP.
- [ ] Don't auto-retry `POST /submit` — 5 per 15 min per IP is the entire budget.
- [ ] Surface `dailyUpdate.ingestionEnabled === false`, `lastSync.guardTripped`, `scheduler.lastRun.error`, `lastFallback.missingPermission`, and the announcement's `scheduler.lastOutcome` — each is an otherwise-invisible outage.
- [ ] `DM_CLOSED` is not a failure; label it "DMs closed — mentioned in channel".
- [ ] A `CANCELLED` broadcast's `outstanding` recipients were **never attempted**, not failed.
