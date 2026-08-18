# Backend Work Required (Frontend → Backend)

Companion to `API_INTEGRATION.md`, which documents the backend as it exists. This is the other direction: what the **frontend needs**, and nothing else.

Verified against the running backend at `http://localhost:8000` and the source at `discord-manager/backend/src` on 2026-08-17.

| #   | Item                                                                         | Status                                                   | Size                      |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------- |
| 1   | `daily-status` module has no HTTP layer — **the whole feature is blocked**   | Done (delivered by `2026-08-17-daily-status-http-layer`) | One module, ~4 files      |
| 2   | No public route exposes the attendance window — the form cannot close itself | Done (delivered by `add-public-attendance-window`)       | One route, one projection |
| 3   | Names are English-only — tighten validation to match                         | Done (delivered by `2026-08-17-daily-status-http-layer`) | One character class       |
| 4   | Dead `DAILY_STATUS_ENABLED` line in backend `.env`                           | Done (delivered by `2026-08-17-daily-status-http-layer`) | One line deleted          |

---

> **Multi-server update (2026-08-18).** The backend now serves one or many identical
> Discord servers from a single deployment. Two things in this document changed as a
> result, and are already implemented:
>
> - **`/api/daily-status`, `/counts` and `/export` accept an optional `guildId`.** Omitted
>   means every configured server. Every row carries `guildId`, `serverLabel` and
>   `serverCount`; `/counts` returns the seven figures plus a `byServer` breakdown built
>   from the same query. The CSV export gains a leading `server` column.
> - **`GET /api/attendance/window` is unchanged.** One shared schedule drives every
>   server, so the window is one answer and takes no server parameter — §2's contract
>   below still holds exactly as written.
>
> `GET /api/attendance/verify-user` and `POST /api/attendance/submit` now carry a
> `servers` array; a submission is recorded in every server the handle belongs to. See
> §5A of `API_INTEGRATION.md` for the full shapes.

## 1. The `daily-status` module needs an HTTP layer

### 1.1 Current state

`src/repositories/dailyStatus.repository.ts` is written, commented and tested. It exports:

```ts
export const dailyStatusRepository = {
  getDailyStatusPage, // ({ date, status, search, page, limit, … }) => { rows, total }
  getDailyStatusCounts, // (date, { includeDeparted? })            => DailyStatusCounts
  listMembersMissingUpdate,
};
```

No module exposes any of it. `src/app.ts` registers `auth`, `users`, `discord`, `schedule`, `reminders`, `attendance` — there is no `dailyStatus.routes.ts`. Confirmed live:

```
GET /api/daily-status/counts?date=2026-08-17  →  404  {"message":"API Not Found!"}
GET /api/daily-status?date=2026-08-17         →  404  {"message":"API Not Found!"}
GET /api/reminders/status   (control)         →  401  ← route exists, needs auth
```

**All the work is the HTTP layer.** No query work, no schema change, no migration.

### 1.2 Files to create

Matching the shape of `src/modules/schedule/` and `src/modules/reminder/`:

```
src/modules/dailyStatus/
  dailyStatus.validation.ts
  dailyStatus.service.ts
  dailyStatus.controller.ts
  dailyStatus.routes.ts
```

Plus one line in `src/app.ts`:

```ts
app.use('/api/daily-status', dailyStatusRouter);
```

All routes are `auth(UserRole.ADMIN)`. Validate query strings with `validateQuery`, not `validateRequest` (these are GETs — see `src/middlewares/validateRequest.ts`). Reuse `dhakaDateSchema` from `@/utils/dhakaDate` for `date`, and `pageQueryShape` from `reminder.validation.ts` for paging. Responses go through `sendResponse`, so the envelope and `meta` are automatic.

### 1.3 Two conversions the controller must do

The only places the frontend contract differs from the repository's internal shape. Both are one-liners; both are hard failures if missed.

**(a) `BigInt` → `number`.** `getDailyStatusCounts` returns every figure as `bigint` (raw `COUNT(*)`), and `JSON.stringify` **throws** on a `bigint` — `TypeError: Do not know how to serialize a BigInt`. That is a 500, not a wrong number. Wrap every count in `Number(...)`.

**(b) Two field renames.** The frontend is already built against these names:

| Repository field | API field               |
| ---------------- | ----------------------- |
| `bothCompleted`  | `bothComplete`          |
| `submittedAt`    | `attendanceSubmittedAt` |

> Emitting the repository's own names instead is fine — say so and the frontend changes two lines. What must not happen is the two drifting apart silently, since a missing field renders as an empty cell rather than an error.

---

### 1.4 `GET /api/daily-status/counts?date=YYYY-MM-DD` 🔐

The seven overview figures. Straight passthrough of `getDailyStatusCounts(date)`.

**Query:** `date` — required, `YYYY-MM-DD`, a real calendar date.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Daily status counts retrieved successfully",
  "data": {
    "date": "2026-08-17", // echo the requested date back
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

The four status buckets must sum to `totalMembers` — the frontend renders each as a percentage of the total and relies on that invariant. Don't let a second definition of any of these numbers appear elsewhere.

**Past dates must work.** The trend chart calls this endpoint **7 times in parallel** (the selected day and the six before it) on every page load. Any date that fails is dropped from the chart rather than plotted as zero, so a date range restriction shows up as a silently short chart.

---

### 1.5 `GET /api/daily-status?date=&page=&limit=&status=&search=` 🔐

The member table. Wraps `getDailyStatusPage`.

| Param    | Type   | Rules                                                                               |
| -------- | ------ | ----------------------------------------------------------------------------------- |
| `date`   | string | **required**, `YYYY-MM-DD`                                                          |
| `page`   | number | optional, integer ≥ 1, default 1                                                    |
| `limit`  | number | optional, integer 1–200, default 50 (frontend sends 50)                             |
| `status` | enum   | optional — `COMPLETE` \| `MISSING_UPDATE` \| `MISSING_ATTENDANCE` \| `MISSING_BOTH` |
| `search` | string | optional — case-insensitive partial match on name, phone, email or Discord username |

`status` and `search` **combine** (AND), and both apply before paging.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Daily status retrieved successfully",
  "meta": { "page": 1, "limit": 50, "total": 1520 },
  "data": [
    {
      "memberId": "…",
      "discordUserId": "…",
      "discordUsername": "rakib_dev",
      "displayName": "Rakib", // may be null
      "name": "Rakibul Hasan", // from the attendance form, may be null
      "email": "rakib@example.com", // may be null
      "phone": "01711000000", // may be null
      "hasAttendance": true,
      "hasDailyUpdate": false,
      "status": "MISSING_UPDATE",
      "attendanceSubmittedAt": "2026-08-17T14:22:31.000Z", // ISO, null when absent
    },
  ],
}
```

`meta.total` must be the **filtered** total (`status` and `search` applied), not the guild size — it drives the pager. `status` per row must come from the same CASE rule as the counts aggregation, or a filtered page will disagree with the cards above it.

`includeDeparted`, `sortBy` and `sortDir` exist in the repository but the frontend does not send them. Expose them or don't; the defaults are correct either way.

---

### 1.6 `GET /api/daily-status/members/:memberId?date=YYYY-MM-DD` 🔐

One member's status plus that day's messages.

**Recommended:** add `getDailyStatusForMember(memberId, date)` to `dailyStatus.repository.ts` rather than composing the status in the service — same reason as above, one definition of the status rule.

Messages come from the existing `dailyUpdateRepository.listUpdatesByMemberAndDate(memberId, date)`, mapped `id → id`, `message → content`, `messageCreatedAt → postedAt` (ISO string). Use `messageCreatedAt`, the instant the message was _sent_ — a message sent 23:58 and persisted 00:01 belongs to the day it was sent.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Member daily status retrieved successfully",
  "data": {
    // …every field from the row shape in §1.5…
    "status": "COMPLETE",
    "messages": [
      {
        "id": "…",
        "content": "Today I finished…",
        "postedAt": "2026-08-17T18:40:12.000Z",
      },
    ],
  },
}
```

`messages: []` is correct and expected when the member posted nothing — the frontend states that explicitly. **404** if `memberId` is unknown.

---

### 1.7 `GET /api/daily-status/export?date=&status=&search=&format=csv|xlsx` 🔐

The filtered export — the only endpoint with no repository function behind it.

Same `date`, `status` and `search` as §1.5, plus `format` (`csv` — what the frontend requests — or `xlsx`). It must honour the **active filter**: an admin exporting "missing both, searching 'rahman'" expects exactly those rows.

Returns a file, _not_ the JSON envelope:

```
Content-Type: text/csv; charset=utf-8
   (or application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
Content-Disposition: attachment; filename="daily-status-2026-08-17.csv"
```

Columns: `discordUsername`, `displayName`, `name`, `phone`, `email`, `status`, `hasAttendance`, `hasDailyUpdate`, `attendanceSubmittedAt`.

Two notes:

- `getDailyStatusPage` clamps `limit` to 500 internally, so a 5,000-member export needs a loop over pages or a dedicated unpaginated query. Stream rows as they are fetched rather than building the file in memory.
- Prefix any cell beginning with `=`, `+`, `-` or `@` with `'`. These rows carry user-submitted names, and a spreadsheet will otherwise execute them as formulas.

---

### 1.8 Turning it on

`DAILY_STATUS_ENABLED` is a **frontend** variable read by `frontend/lib/flags.ts`. The backend has no flag of its own — once the routes exist they are available.

1. Ship the routes.
2. Confirm `GET /api/daily-status/counts?date=…` returns 200 with an admin token.
3. Set `DAILY_STATUS_ENABLED=true` in `frontend/.env.local` and restart the frontend.

**No frontend code changes at any point.** Types, endpoint functions, counts cards, part-to-whole chart, 7-day trend, server-paginated table with filter and search, member detail dialog and export proxy are all written against the contracts above. Until step 3 the page renders a "not yet available" state and issues no request.

---

## 2. `GET /api/attendance/window` 🔓 — a public projection of the submission window

### 2.1 Why

The attendance form is supposed to be available only while submissions are open, and to say so plainly the rest of the time rather than showing a form that leads nowhere. The window it needs is the `#daily-update` schedule — the same row `{{close_time}}` is read from, so the form's hours and the evening announcement's stated deadline can never disagree.

That row is readable only from `GET /api/schedule/daily-update`, which is `auth(ADMIN)`. **Students are `discord_members` rows, not `users`** — they have no credential and never will. So there is no way for the public form to learn its own hours today.

Three non-options, recorded so they are not re-proposed:

- **Duplicating the times in frontend env.** An admin editing the schedule in the dashboard would change the channel and the announcement text while the form silently kept the old hours — with nothing anywhere showing the two had diverged.
- **Giving the Next server admin credentials.** Puts a full-privilege token on the one code path that is reachable without authentication, to read four fields.
- **Relaxing auth on `/schedule/daily-update`.** That payload carries `updatedBy` (admin name and email), `scheduler.lastRun.error` (internal failure strings) and the channel ID. None of it belongs to an anonymous caller.

Hence a separate, deliberately thin public route.

### 2.2 Contract

`src/modules/attendance/attendance.routes.ts` — alongside `verify-user` and `submit`, and like them **with no `auth()` middleware**.

```
GET /api/attendance/window
```

No parameters. Always 200 — this is a question with a routine answer, not an operation that can fail to find something.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Attendance window retrieved successfully",
  "data": {
    "isOpen": true, // right now, per the schedule
    "date": "2026-08-18", // today's Dhaka civil date
    "openTime": "18:00", // HH:mm, Asia/Dhaka
    "closeTime": "23:59",
    "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
    "enabled": true, // false = paused; the window never opens
    "timezone": "Asia/Dhaka",
    "nextOpenAt": "2026-08-19T12:00:00.000Z", // null when disabled
    "closesAt": "2026-08-18T17:59:00.000Z", // null when not currently open
  },
}
```

Every field is a projection of the existing schedule row plus the current Dhaka clock. **No new table, no migration, no Discord call.**

### 2.3 Three decisions worth making deliberately

1. **`isOpen` is the schedule window, not the live channel state.** Do **not** reuse `getSchedule()`'s live `channel.isOpen` read here. That costs a Discord API call per request, and this endpoint is hit by every student loading the form — thousands of times in an evening, against a bot that is also syncing members and pacing reminder DMs. Compute it from `openTime`/`closeTime`/`daysOfWeek`/`enabled` against the Dhaka clock. It also answers the right question: the student is submitting to the form, not posting in the channel.

2. **Nothing admin-shaped may leak.** No `updatedBy`, no `scheduler`, no `lastRun.error`, no channel ID. The response above is the whole response.

3. **Rate limit it like `verify-user` (60/min per IP), or not at all.** It is a cheap in-process read with no user input.

### 2.4 Should `POST /submit` enforce the window too?

**Not as part of this item, and not without deciding the edge case first.** Today `submit` accepts a valid member's attendance at any hour, and this endpoint does not change that — the frontend gate is a courtesy that saves a student filling in four fields at 3 a.m., never an enforcement point.

If you do decide submissions must be refused outside the window, the case to settle is a student who loads the form at 23:58 and submits at 00:01: the honest outcomes are "accept, filed under the day the form was loaded" or "refuse with a message naming the deadline they missed", and silently filing it under the next day is the one outcome that is wrong. Raise it as its own item; a 4xx added here would start rejecting real submissions the moment it shipped.

### 2.5 Turning it on

Nothing to configure and no frontend deploy to coordinate.

`lib/attendance-window.ts` **fails open**: while the route 404s — the state today — it returns `null` and the homepage renders exactly the form it renders now. The gate activates the moment the route answers, and reverts to the open form on any backend outage. That direction is deliberate and tested (`lib/attendance-window.test.ts`): the inverse would show ~5,000 students a "come back later" page during the exact hours they are meant to be submitting, indistinguishable from the window working correctly.

---

## 3. Names are English-only — tighten validation to match

**File:** `src/modules/attendance/attendance.validation.ts:53`

Students enter their full name in **English (Latin letters) only**; Bengali script is not accepted on this field. The current rule is Unicode-wide (`/^[\p{L}\s]+$/u`) and is self-inconsistent besides: `\p{L}` matches Bengali consonants but not the vowel signs (`া` `ি` `ু` `ঃ`), which are marks (`\p{M}`) — so it rejects `রাকিবুল হাসান` while accepting a consonant-only `রকব`.

```ts
.regex(/^[A-Za-z\s]+$/, {
  // English-only by product decision. The message names the script, because
  // "only letters" reads as nonsense to a student who just typed their own
  // name in their own alphabet.
  error: 'Full name must use English letters and spaces only',
}),
```

Tests to update (the first two previously asserted the opposite):

```ts
expect(schema.safeParse({ name: 'রাকিবুল হাসান', … }).success).toBe(false);
expect(schema.safeParse({ name: 'মোঃ আবির',      … }).success).toBe(false);
expect(schema.safeParse({ name: 'Rakibul Hasan', … }).success).toBe(true);
expect(schema.safeParse({ name: 'Rakib 2',       … }).success).toBe(false); // digits still rejected
```

The frontend already enforces `^[A-Za-z\s]+$` and says so in the field hint before anything is typed, so nothing is broken meanwhile — it simply refuses input the backend would accept. Apostrophes and hyphens (`D'Souza`, `Abdur-Rahman`) are rejected by both the old and new rules; widen on both sides together if they show up in real submissions.

---

## 4. Remove the dead `.env` line

`backend/.env:46` contains `DAILY_STATUS_ENABLED=true`. Nothing under `backend/src/` reads it (confirmed by grep) — it gates the frontend, not the routes, and leaving it there will convince the next person the feature is on when it is not. Delete the line.

---

## Verification checklist

Against a running backend with an admin token (`Authorization: <token>` — **bare, no `Bearer` prefix**):

- [x] `GET /api/daily-status/counts?date=<today>` → 200, seven figures, all JSON **numbers** not strings
- [x] The four buckets sum to `totalMembers`
- [x] The same call for a date 6 days ago → 200 (the trend needs it)
- [x] `GET /api/daily-status?date=<today>&limit=5` → 200, `meta.total` present
- [x] `…&status=MISSING_UPDATE` → `meta.total` drops to the filtered count, and matches `missingUpdateOnly` from the counts endpoint
- [x] `…&search=<partial username>` → narrows, case-insensitively, and combines with `status`
- [x] `GET /api/daily-status/members/<id>?date=<today>` → 200 with `messages: []` for a member who posted nothing
- [x] `GET /api/daily-status/members/<unknown-id>?date=<today>` → 404
- [x] `GET /api/daily-status/export?date=<today>&format=csv` → CSV attachment honouring `status`/`search`
- [x] All routes → 401 without a token
- [x] `GET /api/attendance/window` → 200 **without** a token, and the body carries no `updatedBy`, `scheduler` or channel ID (item 2)
- [x] Inside the window `isOpen` is `true` and `closesAt` is set; outside it `isOpen` is `false` and `nextOpenAt` is set
- [x] With `{ "enabled": false }` on the schedule → `enabled: false`, `isOpen: false`, `nextOpenAt: null`
- [x] Hitting it repeatedly produces **no** Discord API traffic (item 2, decision 1)
- [x] `POST /api/attendance/submit` accepts `name: "Rakibul Hasan"`, rejects `name: "রাকিবুল হাসান"` with 400 (item 3)
- [x] `grep -rn DAILY_STATUS_ENABLED backend/` returns nothing (item 4)

---

## Reference

- `API_INTEGRATION.md` §13 — the original record that these routes do not exist
- `API_INTEGRATION.md` §8.4 — the schedule row item 2 projects, and §8.6 for the two existing public routes it sits beside
- `frontend/lib/attendance-window.ts` — the fail-open client, and `lib/attendance-window.test.ts` for the behaviour it pins
- `src/repositories/dailyStatus.repository.ts` — the query layer, already done
- `src/modules/reminder/` — closest analogue: date query, pagination, `meta`
- `src/modules/schedule/` — closest analogue for admin-only route structure
- `src/middlewares/validateRequest.ts` — `validateQuery` for GET, `validateRequest` for body
- `src/utils/dhakaDate.ts` — `dhakaDateSchema`, `getDhakaDate`
- `src/utils/sendResponse.ts` — the envelope and `meta` shape
