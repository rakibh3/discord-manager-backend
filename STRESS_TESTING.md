# Stress Testing Guide — 5,000 Users

> **Scope**: every endpoint that handles student traffic or aggregates data for
> 5,000 members. Auth endpoints (`/api/auth/*`) are **excluded** — only one or
> two administrators ever log in concurrently.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Seed Data Generation](#2-seed-data-generation)
3. [Test Scenarios](#3-test-scenarios)
4. [Ramp-Up Strategy](#4-ramp-up-strategy)
5. [Running the Tests](#5-running-the-tests)
6. [Monitoring During Tests](#6-monitoring-during-tests)
7. [Analysing Results](#7-analysing-results)
8. [Rate Limiter Considerations](#8-rate-limiter-considerations)

---

## 1. Prerequisites

| Tool       | Purpose                                                | Install                         |
| ---------- | ------------------------------------------------------ | ------------------------------- |
| **k6**     | Load generator (writes JS, outputs p95/p99/throughput) | `brew install k6`               |
| **Docker** | Postgres 16 + Redis 7                                  | Already in `docker-compose.yml` |
| **psql**   | Enable `pg_stat_statements`, inspect query plans       | Ships with Postgres             |
| **jq**     | Parse k6 JSON output                                   | `brew install jq`               |

### Enable `pg_stat_statements` (one-time)

```sql
-- connect to the running container
-- docker exec -it discord_manager_postgres psql -U postgres -d discord_manager
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT pg_stat_statements_reset();   -- clean slate before each run
```

### Disable rate limiters for test runs

The in-memory rate limiters in `src/middlewares/rateLimit.ts` will throttle k6
at 5 requests / 15 min on the submit path. For testing, either:

- **Option A** — set `NODE_ENV=test` and skip the middleware when that flag is
  set (add a one-line guard).
- **Option B** — run k6 from many source IPs via `--local-ips` (complex).
- **Option C** — temporarily raise the limits to `999999` in `.env.test`.

> **⚠️ WARNING**: Never deploy with rate limiters disabled. Re-enable them after every test run.

---

## 2. Seed Data Generation

Stress testing against 10 rows is meaningless. The seed must approximate
production volume before any k6 script runs.

### Target volumes

| Table                 | Rows                                                     | Derivation                               |
| --------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `discord_members`     | **5,000** per guild × 2 guilds = **10,000**              | One record per (server, Discord account) |
| `attendances`         | 30 days × 10,000 members = **300,000**                   | One per member per Dhaka day             |
| `daily_updates`       | ~3 msgs / member / day × 30 days × 10,000 = **~900,000** | Multiple messages per day is realistic   |
| `reminder_logs`       | **50**                                                   | Past broadcast sessions                  |
| `reminder_recipients` | 50 × ~1,000 targets = **~50,000**                        | Subset of members per broadcast          |

### Seed script outline

Create `prisma/seed-stress.ts`:

```ts
import { PrismaClient } from '@generated/prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

const GUILD_IDS = ['<guild_a_id>', '<guild_b_id>'];
const MEMBERS_PER_GUILD = 5_000;
const DAYS = 30;

async function main() {
  // 1. Create members in batches of 500
  for (const guildId of GUILD_IDS) {
    for (let batch = 0; batch < MEMBERS_PER_GUILD / 500; batch++) {
      const members = Array.from({ length: 500 }, (_, i) => {
        const idx = batch * 500 + i;
        return {
          id: randomUUID(),
          guildId,
          discordUserId: `${100000000000000000n + BigInt(idx)}`,
          discordUsername: `stressuser_${guildId.slice(-4)}_${idx}`,
          displayName: `Stress User ${idx}`,
          email: `stress${idx}@test.local`,
          phone: `+880170000${String(idx).padStart(4, '0')}`,
          isInGuild: true,
        };
      });
      await prisma.discordMember.createMany({ data: members });
    }
  }

  // 2. Fetch all member IDs
  const allMembers = await prisma.discordMember.findMany({
    select: { id: true, guildId: true, discordUsername: true },
  });

  // 3. Create attendance rows (batch insert by day)
  for (let d = 0; d < DAYS; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD

    // ~85% of members submit each day (realistic)
    const submitters = allMembers.filter(() => Math.random() < 0.85);

    // Batch in chunks of 1,000
    for (let i = 0; i < submitters.length; i += 1000) {
      const chunk = submitters.slice(i, i + 1000);
      await prisma.attendance.createMany({
        data: chunk.map((m) => ({
          memberId: m.id,
          name: `Name ${m.discordUsername}`,
          email: `${m.discordUsername}@test.local`,
          phone: '+8801700000000',
          attendanceDate: dateStr,
        })),
      });
    }
  }

  // 4. Create daily_updates (same approach, ~3 per member per day)
  for (let d = 0; d < DAYS; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10);

    const posters = allMembers.filter(() => Math.random() < 0.7);
    for (let i = 0; i < posters.length; i += 1000) {
      const chunk = posters.slice(i, i + 1000);
      const rows = chunk.flatMap((m) => {
        const count = Math.ceil(Math.random() * 3);
        return Array.from({ length: count }, (_, j) => ({
          memberId: m.id,
          discordMessageId: `${Date.now()}${m.id.slice(0, 8)}${j}`,
          channelId: '000000000000000000',
          message: `Daily update #${j + 1} from ${m.discordUsername} on ${dateStr}`,
          messageDate: dateStr,
          messageCreatedAt: new Date(),
        }));
      });
      await prisma.dailyUpdate.createMany({ data: rows });
    }
  }

  console.log('Stress seed complete.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run with:

```bash
tsx prisma/seed-stress.ts
```

> **ℹ️ IMPORTANT**: Run `VACUUM ANALYZE;` after seeding so the query planner has accurate
> statistics. Without it, Postgres may choose sequential scans over index
> scans, and the test would measure a problem the planner would solve itself
> in production.

---

## 3. Test Scenarios

Each scenario maps to a real user action or system event at 5,000-member scale.

### 3.1 Attendance Submission Storm

**What**: 5,000 students submit `POST /api/attendance/submit` within a 30-minute
window — the realistic peak.

**Why it matters**: concurrent `INSERT`s hit the
`@@unique([memberId, attendanceDate])` constraint. The transaction in
`attendance.repository.ts` also `UPDATE`s `discord_members` per submission.

```js
// k6/attendance-submit.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const members = new SharedArray('members', function () {
  return JSON.parse(open('./data/members.json'));
  // Array of { discordUsername, name, email, phone }
});

export const options = {
  scenarios: {
    attendance_storm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '1m', target: 2000 },
        { duration: '2m', target: 5000 },
        { duration: '3m', target: 5000 }, // hold
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const member = members[__VU % members.length];

  const res = http.post(
    'http://localhost:8000/api/attendance/submit',
    JSON.stringify({
      discordUsername: member.discordUsername,
      name: member.name,
      email: member.email,
      phone: member.phone,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(res, {
    'status is 200 or 409': (r) => r.status === 200 || r.status === 409,
  });

  sleep(0.1);
}
```

**What to watch**:

- P2002 errors handled gracefully (409, not 500)
- Connection pool exhaustion (socket hang up / ECONNREFUSED)
- Transaction deadlocks between the `INSERT` and the `UPDATE`

---

### 3.2 Verify User (Debounced Lookups)

**What**: students type their Discord handle and the form fires
`GET /api/attendance/verify-user?discordUsername=...` on a 500 ms debounce.

**Why it matters**: at 5,000 concurrent form sessions, this generates ~10,000
req/s in bursts. The query hits `findActiveMembersByUsername` →
`@@index([discordUsername])`.

```js
// k6/verify-user.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const usernames = new SharedArray('usernames', function () {
  return JSON.parse(open('./data/usernames.json'));
});

export const options = {
  scenarios: {
    verify_burst: {
      executor: 'constant-arrival-rate',
      rate: 5000, // 5,000 requests per second
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 500,
      maxVUs: 2000,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.005'],
  },
};

export default function () {
  const username = usernames[__VU % usernames.length];

  const res = http.get(
    `http://localhost:8000/api/attendance/verify-user?discordUsername=${username}`,
  );

  check(res, {
    'is 200': (r) => r.status === 200,
  });

  sleep(0.05);
}
```

**What to watch**:

- Index scan vs. sequential scan (check `EXPLAIN ANALYZE`)
- Response time under burst (target: p95 < 200 ms)
- Prisma connection pool saturation

---

### 3.3 Attendance Window Check

**What**: every form load calls `GET /api/attendance/window` to show whether the
submission window is open.

**Why it matters**: this is the highest-frequency public endpoint. It reads a
single `channel_schedules` row — should be trivial, but connection pool
contention makes even small reads slow under load.

```js
// k6/attendance-window.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    window_poll: {
      executor: 'constant-arrival-rate',
      rate: 10000,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 500,
      maxVUs: 3000,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<100'],
  },
};

export default function () {
  const res = http.get('http://localhost:8000/api/attendance/window');
  check(res, { 'is 200': (r) => r.status === 200 });
}
```

**What to watch**:

- This is a cache candidate — identical result for all users within a minute
- Connection pool starvation when combined with submit traffic

---

### 3.4 Daily Status Dashboard (Aggregation Reads)

**What**: admin loads the dashboard → `GET /api/daily-status/counts?date=...`
and `GET /api/daily-status?date=...&page=1&limit=50`.

**Why it matters**: these are heavy raw SQL queries that `LEFT JOIN` three
tables across all 5,000+ member rows. A single request is fine; the concern is
whether they can serve while 5,000 attendance submissions are hitting the same
tables.

```js
// k6/daily-status.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';

const AUTH_TOKEN = __ENV.ADMIN_TOKEN; // pass via k6 -e ADMIN_TOKEN=...
const BASE = 'http://localhost:8000/api/daily-status';

export const options = {
  vus: 5, // only a few admin sessions, but running while submit storm is active
  duration: '5m',
};

export default function () {
  const today = new Date().toISOString().slice(0, 10);
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };

  group('Dashboard load', () => {
    const counts = http.get(`${BASE}/counts?date=${today}`, { headers });
    check(counts, { 'counts 200': (r) => r.status === 200 });

    const page = http.get(`${BASE}?date=${today}&page=1&limit=50`, { headers });
    check(page, { 'page 200': (r) => r.status === 200 });
  });

  sleep(5); // admin refreshes every ~5s
}
```

**What to watch**:

- `counts` query p95 (target: < 1 s with 5,000 members and 300K attendance rows)
- Lock contention between read queries and concurrent attendance writes
- Whether Postgres uses the `@@index([attendanceDate])` and
  `@@index([guildId, isInGuild])` indexes

---

### 3.5 Daily Status CSV Export

**What**: admin exports all 5,000 members for a date via
`GET /api/daily-status/export?date=...&format=csv`.

**Why it matters**: the service streams in batches of 500
(`dailyStatus.service.ts`), issuing repeated paginated queries
under load. At 5,000 members per guild that is 10+ sequential queries.

```js
// k6/export.js
import http from 'k6/http';
import { check } from 'k6';

const AUTH_TOKEN = __ENV.ADMIN_TOKEN;

export const options = {
  vus: 3,
  iterations: 10,
};

export default function () {
  const today = new Date().toISOString().slice(0, 10);
  const res = http.get(
    `http://localhost:8000/api/daily-status/export?date=${today}&format=csv`,
    {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      responseType: 'text',
    },
  );

  check(res, {
    'is 200': (r) => r.status === 200,
    'has CSV data': (r) => r.body.includes('discordUsername'),
    'all members': (r) => r.body.split('\n').length > 4000,
  });
}
```

---

### 3.6 Reminder Broadcast (5,000 DMs)

**What**: admin triggers `POST /api/reminders/send` → BullMQ enqueues 5,000
jobs → worker processes them at 2/sec.

**Why it matters**: this exercises the full Redis + BullMQ pipeline. The
broadcast takes ~40 minutes at 2 DMs/sec. The test validates that:

- Redis does not run out of memory
- The worker does not starve the API's event loop
- Progress reads (`GET /api/reminders/:id`) remain fast during delivery

```js
// k6/reminder-broadcast.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const AUTH_TOKEN = __ENV.ADMIN_TOKEN;
const BASE = 'http://localhost:8000/api/reminders';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Preview targets
  const preview = http.get(
    `${BASE}/targets?date=${today}&criterion=MISSING_UPDATE&minMissedDays=1`,
    { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  );
  check(preview, { 'preview 200': (r) => r.status === 200 });

  const targetCount = JSON.parse(preview.body).data?.targetCount ?? 0;
  console.log(`Targets: ${targetCount}`);

  // 2. Send broadcast
  const send = http.post(
    `${BASE}/send`,
    JSON.stringify({
      date: today,
      criterion: 'MISSING_UPDATE',
      minMissedDays: 1,
      message: 'Stress test reminder — please ignore.',
    }),
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  );
  check(send, {
    'send 202 or 200': (r) => r.status === 202 || r.status === 200,
  });

  if (send.status >= 300) return;

  const broadcastId = JSON.parse(send.body).data?.id;

  // 3. Poll progress every 10s for up to 50 minutes
  for (let i = 0; i < 300; i++) {
    sleep(10);
    const progress = http.get(`${BASE}/${broadcastId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const data = JSON.parse(progress.body).data;
    console.log(
      `Progress: ${data?.delivered}/${data?.targetCount} — ${data?.status}`,
    );

    if (data?.status === 'COMPLETED' || data?.status === 'FAILED') break;
  }
}
```

> **ℹ️ NOTE**: In a test environment without a real Discord bot, the worker will fail every
> DM with a Discord API error. That is expected — the test validates the queue
> pipeline, connection handling, and database updates, not Discord delivery.

---

### 3.7 Member Sync Under Load

**What**: admin triggers `POST /api/discord/sync` → the bot fetches all guild
members and upserts them into `discord_members`.

**Why it matters**: a full sync of 5,000 members involves 5,000 individual
upserts. If the sync runs during an attendance storm, the writes compete for
the same rows.

This is best tested by triggering the sync endpoint while the attendance submit
k6 script is running concurrently:

```bash
# Terminal 1 — start the attendance storm
k6 run k6/attendance-submit.js

# Terminal 2 — trigger sync mid-storm
curl -X POST http://localhost:8000/api/discord/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

---

### 3.8 Combined Scenario (Realistic Peak)

The real stress case is everything happening at once. Run these concurrently:

```bash
# Window — all form loads
k6 run k6/attendance-window.js &

# Verify — debounced handle lookups
k6 run k6/verify-user.js &

# Submit — the write storm
k6 run k6/attendance-submit.js &

# Dashboard — admin watching live
k6 run -e ADMIN_TOKEN="$TOKEN" k6/daily-status.js &

wait
```

This is where connection pool exhaustion and query plan degradation surface.

---

## 4. Ramp-Up Strategy

A sudden jump to 5,000 VUs hides gradual degradation. Use staged ramps:

```
Phase    Duration    VUs       Purpose
─────    ────────    ────      ────────────────────────────────
1        0–30s       0 → 100   Baseline — confirm no errors
2        30s–1m      100       Hold — measure stable latency
3        1m–1m30s    100→1000  Find the first knee
4        1m30s–2m    1000      Hold — confirm recovery
5        2m–3m       1000→5000 Full load
6        3m–6m       5000      Soak — look for memory leaks, GC
7        6m–6m30s    5000→0    Cooldown — confirm graceful drain
```

---

## 5. Running the Tests

### Prepare the test data files

```bash
mkdir -p k6/data

# Export member usernames from the database
psql "$DATABASE_URL" -t -A -c \
  "SELECT json_agg(json_build_object(
    'discordUsername', discord_username,
    'name', COALESCE(display_name, discord_username),
    'email', COALESCE(email, discord_username || '@test.local'),
    'phone', COALESCE(phone, '+8801700000000')
  ))
  FROM discord_members
  WHERE is_in_guild = true
  LIMIT 5000;" > k6/data/members.json

# Usernames only for the verify test
psql "$DATABASE_URL" -t -A -c \
  "SELECT json_agg(discord_username)
  FROM discord_members
  WHERE is_in_guild = true
  LIMIT 5000;" > k6/data/usernames.json
```

### Run a single scenario

```bash
k6 run k6/attendance-submit.js
```

### Run with the built-in dashboard

```bash
k6 run --out dashboard k6/attendance-submit.js
# Opens http://localhost:5665 with a live metrics dashboard
```

### Run with JSON output for later analysis

```bash
k6 run --out json=k6/results/submit-$(date +%s).json k6/attendance-submit.js
```

---

## 6. Monitoring During Tests

### Postgres — live query activity

```sql
-- Active queries right now
SELECT pid, state, wait_event_type, query
FROM pg_stat_activity
WHERE datname = 'discord_manager'
  AND state != 'idle'
ORDER BY query_start;

-- Connection count
SELECT count(*) FROM pg_stat_activity
WHERE datname = 'discord_manager';
```

### Postgres — slowest queries (after the run)

```sql
SELECT
  calls,
  round(mean_exec_time::numeric, 2) AS avg_ms,
  round(max_exec_time::numeric, 2) AS max_ms,
  rows,
  substr(query, 1, 120) AS query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### Docker — container resource usage

```bash
docker stats discord_manager_postgres discord_manager_redis
```

### Redis — queue depth

```bash
docker exec discord_manager_redis redis-cli LLEN bull:reminder-dm:wait
docker exec discord_manager_redis redis-cli INFO memory | grep used_memory_human
```

### Node.js — event loop lag

Add to `server.ts` temporarily:

```ts
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    const lag = performance.now() - start;
    if (lag > 50) console.warn(`Event loop lag: ${lag.toFixed(0)}ms`);
  });
}, 1000);
```

---

## 7. Analysing Results

### Pass / fail thresholds

| Metric               | Target           | Action if exceeded                      |
| -------------------- | ---------------- | --------------------------------------- |
| p95 latency (submit) | < 500 ms         | Tune connection pool or add PgBouncer   |
| p99 latency (submit) | < 1500 ms        | Check for table lock contention         |
| p95 latency (verify) | < 200 ms         | Confirm index is being used             |
| p95 latency (window) | < 100 ms         | Add in-memory cache (1 min TTL)         |
| p95 latency (counts) | < 1000 ms        | Optimize raw SQL or add summary table   |
| Error rate           | < 1%             | Connection pool exhaustion or deadlocks |
| 409 rate (submit)    | Informational    | Expected for duplicate submissions      |
| Throughput plateau   | Note the ceiling | Connection pool or CPU saturation       |

### Key questions to answer

1. **At what VU count does p95 latency cross 500 ms?** — This is the practical
   user capacity.
2. **Are there any 5xx errors?** — Indicates connection pool exhaustion, OOM,
   or unhandled exceptions.
3. **Do counts queries remain under 1 s while submits are running?** — Read/write
   contention on the same tables.
4. **Does memory usage grow linearly during the soak?** — A leak in the Node
   process or unbounded Prisma query results.

---

## 8. Rate Limiter Considerations

The production rate limiters are **in-memory** (process-local):

| Endpoint           | Budget    | Window |
| ------------------ | --------- | ------ |
| `GET /verify-user` | 60 req/IP | 1 min  |
| `POST /submit`     | 5 req/IP  | 15 min |
| `GET /window`      | 60 req/IP | 1 min  |

### Impact on stress testing

k6 runs from a single machine → single IP → hits the budget after 5 submits.
You **must** neutralise the limiters during the test (see
[Prerequisites](#1-prerequisites)).

### Impact on production

With 5,000 students behind campus NAT (shared IP), the submit budget of
5 req / 15 min / IP is a real bottleneck. Students behind the same router
share the budget. If this surfaces in production:

1. Switch to a Redis-backed store (`rate-limit-redis`) so the budget is
   consistent across processes.
2. Consider identifying students by `discordUsername` (from the request body)
   rather than IP, since handles are verified against the directory.
