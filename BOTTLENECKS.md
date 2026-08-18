# Bottlenecks & Infrastructure Gaps — 5,000 Users

> **Purpose**: a reference for every known bottleneck and infrastructure gap in
> the current backend when scaled to 5,000 concurrent users. Each item names
> the problem, explains why it matters, and provides a concrete resolution path.

---

## Table of Contents

1. [Prisma Connection Pool](#1-prisma-connection-pool)
2. [PostgreSQL `max_connections`](#2-postgresql-max_connections)
3. [PostgreSQL Memory Tuning](#3-postgresql-memory-tuning)
4. [Attendance Transaction Contention](#4-attendance-transaction-contention)
5. [Daily Status Raw SQL at Scale](#5-daily-status-raw-sql-at-scale)
6. [Rate Limiter — Process-Local Store](#6-rate-limiter--process-local-store)
7. [Rate Limiter — NAT Collisions](#7-rate-limiter--nat-collisions)
8. [Attendance Window — Missing Cache](#8-attendance-window--missing-cache)
9. [BullMQ Worker — Event Loop Contention](#9-bullmq-worker--event-loop-contention)
10. [Redis Memory Ceiling](#10-redis-memory-ceiling)
11. [Member Sync — Sequential Upserts](#11-member-sync--sequential-upserts)
12. [CSV Export — Unbounded Streaming](#12-csv-export--unbounded-streaming)
13. [Single-Process Architecture](#13-single-process-architecture)
14. [Missing Health Check Endpoint](#14-missing-health-check-endpoint)
15. [Summary — Priority Matrix](#15-summary--priority-matrix)

---

## 1. Prisma Connection Pool

### The Problem

The Prisma client in `src/lib/prisma.ts` is instantiated with the
`@prisma/adapter-pg` driver adapter and no explicit pool configuration:

```ts
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
```

When using the `@prisma/adapter-pg` driver adapter, Prisma delegates connection
management to the underlying `pg` library's `Pool`. The default pool size for
`pg.Pool` is **10 connections**. At 5,000 concurrent requests, every connection
is occupied and new requests queue behind them. Once the queue grows long enough,
requests start timing out with `ECONNREFUSED` or hanging indefinitely.

### Why It Matters

This is the **#1 most likely cause of failure** at 5,000 users. Every database
interaction — reads, writes, transactions — goes through this pool. The
attendance submission path holds a transaction (INSERT + UPDATE) for each
request, meaning 10 concurrent transactions is the ceiling before queuing starts.

### Resolution

**Option A — Configure the `pg` Pool directly** (simplest):

```ts
import pg from 'pg';

const pool = new pg.Pool({
  connectionString,
  max: 30, // 30 connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const adapter = new PrismaPg({ pool });
const prisma = new PrismaClient({ adapter });
```

**Option B — Add PgBouncer** (recommended for production):

Add to `docker-compose.yml`:

```yaml
pgbouncer:
  image: edoburu/pgbouncer:latest
  environment:
    DATABASE_URL: postgresql://postgres:password@postgres:5432/discord_manager
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 1000
    DEFAULT_POOL_SIZE: 30
  ports:
    - '6432:6432'
  depends_on:
    - postgres
```

Then point `DATABASE_URL` to `pgbouncer:6432` instead of `postgres:5432`.

**Recommended pool size**: 20–30 for a single Postgres instance. Going higher
(50+) risks overwhelming Postgres itself.

---

## 2. PostgreSQL `max_connections`

### The Problem

The `postgres:16-alpine` Docker image defaults to `max_connections = 100`. With
a Prisma pool of 30, plus the Redis-backed BullMQ worker's own connections, plus
`psql` sessions during monitoring, 100 can be reached during a stress test.

### Why It Matters

Exceeding `max_connections` produces `FATAL: too many connections for role`.
Unlike pool exhaustion (which queues), this is a hard rejection — no retry, no
queue, immediate failure.

### Resolution

Add a custom `postgresql.conf` or pass the setting via command:

```yaml
# docker-compose.yml
postgres:
  image: postgres:16-alpine
  command: ['postgres', '-c', 'max_connections=200']
```

If using PgBouncer, Postgres `max_connections` can stay at 100 because PgBouncer
multiplexes thousands of client connections across a smaller pool.

---

## 3. PostgreSQL Memory Tuning

### The Problem

Alpine defaults are tuned for minimal resource usage, not query performance:

| Setting                | Alpine Default | Impact at Scale                                                  |
| ---------------------- | -------------- | ---------------------------------------------------------------- |
| `shared_buffers`       | 128 MB         | Postgres caches very little; hot tables re-read from disk        |
| `work_mem`             | 4 MB           | Complex sorts/joins in daily status queries spill to disk        |
| `effective_cache_size` | 4 GB           | Query planner underestimates memory and prefers sequential scans |
| `maintenance_work_mem` | 64 MB          | `VACUUM ANALYZE` after seeding is slow                           |

### Why It Matters

The `dailyStatus.repository.ts` queries are raw SQL with multiple LEFT JOINs
and GROUP BY across 5,000+ member rows, 300K+ attendance rows, and 900K+ daily
update rows. With 4 MB `work_mem`, intermediate hash tables spill to disk
temporary files, turning a 200 ms query into a 3 s one.

### Resolution

```yaml
# docker-compose.yml
postgres:
  command:
    - 'postgres'
    - '-c'
    - 'max_connections=200'
    - '-c'
    - 'shared_buffers=512MB'
    - '-c'
    - 'work_mem=32MB'
    - '-c'
    - 'effective_cache_size=1GB'
    - '-c'
    - 'maintenance_work_mem=128MB'
```

Sizing guidance:

- `shared_buffers`: 25% of container memory (if container has 2 GB → 512 MB)
- `work_mem`: 32 MB is generous for this workload; keep below 64 MB to avoid
  per-connection memory explosions with 200 connections (200 × 64 MB = 12.8 GB)
- Run `EXPLAIN (ANALYZE, BUFFERS)` on the daily status count query to verify
  no sorts spill to disk after tuning

---

## 4. Attendance Transaction Contention

### The Problem

Each attendance submission in `attendance.repository.ts` runs a transaction:

1. `INSERT INTO attendances` (hits the unique constraint)
2. `UPDATE discord_members SET email = ..., phone = ...` (same row the verify
   query is reading)

With 5,000 concurrent submissions, Postgres serialisation on the
`discord_members` UPDATE creates a contention point. Two students who share a
server and submit at the same millisecond compete for a lock on different
`discord_members` rows, which is fine — but the transaction also reads from
`discord_members` in `resolveActiveMembers` before writing, creating a
read-then-write pattern that Postgres can deadlock under high concurrency.

### Why It Matters

Deadlocks produce Prisma errors that, if unhandled, return 500s. Even without
deadlocks, row-level locks on the UPDATE serialise concurrent submissions for
members in the same guild.

### Resolution

**Short term** — Add deadlock retry logic to the attendance service:

```ts
const MAX_RETRIES = 3;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    return await attendanceRepository.createAttendanceForMembers(inputs);
  } catch (error) {
    if (isDeadlockError(error) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 50 * attempt)); // backoff
      continue;
    }
    throw error;
  }
}
```

**Medium term** — Decouple the contact-detail UPDATE from the attendance INSERT.
The UPDATE on `discord_members` is a convenience sync, not part of the attendance
contract. Moving it to an async background job (or a Postgres trigger) removes
the row lock from the transaction entirely:

```ts
// In the transaction: only the INSERT
const attendance = await tx.attendance.create({ data: input });

// After the transaction commits: fire-and-forget contact update
void prisma.discordMember
  .update({
    where: { id: input.memberId },
    data: { email: input.email, phone: input.phone },
  })
  .catch(logger.warn);
```

---

## 5. Daily Status Raw SQL at Scale

### The Problem

The daily status repository (`dailyStatus.repository.ts`, ~1,300 lines) builds
the dashboard from raw SQL queries that:

1. LEFT JOIN `discord_members` (10K rows) against `attendances` (300K) and
   `daily_updates` (900K) filtered by date
2. GROUP BY `discord_user_id` to collapse multi-server members into one row
3. Compute CASE expressions for status buckets
4. Count aggregations for summary figures

These queries run on every dashboard page load and every CSV export batch.

### Why It Matters

At production volume, without proper indexing and statistics, the query planner
may:

- Choose a sequential scan on `attendances` instead of the
  `@@index([attendanceDate])` index
- Materialise a hash join larger than `work_mem` and spill to disk
- Hold a shared lock that blocks concurrent attendance INSERTs

### Resolution

1. **Verify index usage** after seeding at scale:

   ```sql
   EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
   -- paste the daily status count query here
   ```

   Look for `Seq Scan` where `Index Scan` is expected.

2. **Add a partial index** for the most common query pattern:

   ```sql
   CREATE INDEX idx_discord_members_active
   ON discord_members (discord_user_id, guild_id)
   WHERE is_in_guild = true;
   ```

   This directly serves the `WHERE dm.is_in_guild = true` filter that every
   daily status query uses, eliminating departed members before the join.

3. **Consider a materialised view** for the counts endpoint if it exceeds 1 s:
   ```sql
   CREATE MATERIALIZED VIEW daily_status_summary AS
   -- the counts query
   WITH DATA;

   -- Refresh on a schedule or after attendance writes
   REFRESH MATERIALIZED VIEW CONCURRENTLY daily_status_summary;
   ```
   This trades real-time accuracy for speed. A 1-minute refresh interval is
   acceptable for dashboard display.

---

## 6. Rate Limiter — Process-Local Store

### The Problem

The rate limiters in `src/middlewares/rateLimit.ts` use the `express-rate-limit`
default store, which is an in-memory `Map` inside the Node process:

```ts
// No `store:` option → defaults to MemoryStore
export const submitAttendanceRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  ...
});
```

This is explicitly documented as a known limitation in the codebase comments.

### Why It Matters

If you ever run multiple Node processes (PM2, cluster mode, or multiple
containers), each process has its own counter. A client that distributes 5
requests across 3 processes gets 15 attempts before any limiter fires.

### Resolution

When scaling to multiple processes, switch to `rate-limit-redis`:

```ts
import RedisStore from 'rate-limit-redis';
import { getRedisConnection } from '@/lib/queue/connection';

const store = new RedisStore({
  sendCommand: (...args: string[]) => getRedisConnection().call(...args),
});

export const submitAttendanceRateLimiter = rateLimit({
  store,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  ...
});
```

> **⚠️ CAUTION**: The codebase deliberately keeps the public rate limiters off
> Redis so that a Redis outage does not block the attendance form (the path
> ~5,000 students depend on). If you move to Redis, handle the fallback: use
> MemoryStore as a degraded backup when `isRedisAvailable()` returns false.

---

## 7. Rate Limiter — NAT Collisions

### The Problem

The rate limiters count by IP address. In a campus environment, all 5,000
students may share one or a few public IPs through NAT. The submit budget of
**5 requests per 15 minutes per IP** means the 6th student behind the same
router is blocked.

### Why It Matters

This is a **production correctness issue**, not a performance issue. Real
students will be unable to submit attendance — and the rate limiter returns 429
with no way to retry until the window resets.

### Resolution

**Option A — Identify by `discordUsername` instead of IP** for the submit
endpoint only:

```ts
export const submitAttendanceRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    // Fall back to IP if body is missing — Zod will reject it anyway
    return req.body?.discordUsername?.toLowerCase() ?? req.ip;
  },
  ...
});
```

This is safe because the Discord username is verified against the guild
directory in the service layer. A fake username gets a 404, not a submission.

**Option B — Increase the IP budget** to account for NAT:

```ts
limit: 50,  // 50 per 15 min per IP — enough for ~50 students behind one NAT
```

This trades abuse protection for accessibility. Combine with Option A for both.

---

## 8. Attendance Window — Missing Cache

### The Problem

`GET /api/attendance/window` queries `channel_schedules` on every request. At
5,000 form loads this is 5,000 identical queries returning the same row.

### Why It Matters

The query itself is cheap (single row by unique key), but at 10,000 req/s
during peak, it consumes connection pool slots that the submit and verify paths
need. Connection pool starvation from trivial reads is the worst kind of
bottleneck — invisible until the important queries start timing out.

### Resolution

Cache the result in memory with a 60-second TTL:

```ts
let cachedWindow: TAttendanceWindowResult | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

const getAttendanceWindow = async (): Promise<TAttendanceWindowResult> => {
  const now = Date.now();
  if (cachedWindow && now - cachedAt < CACHE_TTL_MS) {
    return cachedWindow;
  }

  const result = await computeAttendanceWindow(); // current logic
  cachedWindow = result;
  cachedAt = now;
  return result;
};
```

This eliminates ~99.9% of database reads for this endpoint with no correctness
impact — the schedule changes at most a few times per day.

---

## 9. BullMQ Worker — Event Loop Contention

### The Problem

The reminder worker runs in the same Node process as the Express API
(`server.ts`, line 116: `startReminderWorker()`). Each DM delivery involves:

1. Reading the broadcast status from Postgres
2. Sending a Discord API request (~200–500 ms)
3. Updating the recipient row in Postgres

At 2 DMs/sec over 40 minutes, this adds a constant background load of
database operations and network I/O to the API process.

### Why It Matters

While each individual operation is non-blocking (async I/O), the accumulated
GC pressure from thousands of Promise allocations and the worker's event
callbacks can add 10–50 ms of event loop lag, which is visible as p99 spikes
on otherwise fast API responses.

### Resolution

**Short term** — Monitor event loop lag during a broadcast and quantify the
impact:

```ts
// Add to server.ts temporarily
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    const lag = performance.now() - start;
    if (lag > 20) logger.warn(`Event loop lag: ${lag.toFixed(0)}ms`);
  });
}, 1000);
```

**Medium term** — Run the worker in a separate process:

```bash
# Process 1: API only (REMINDER_WORKER_ENABLED=false)
REMINDER_WORKER_ENABLED=false node dist/src/server.js

# Process 2: Worker only (does not listen on PORT)
SCHEDULER_ENABLED=false REMINDER_WORKER_ENABLED=true node dist/src/worker.js
```

The `.env` already has `REMINDER_WORKER_ENABLED` and `SCHEDULER_ENABLED` flags
for exactly this purpose. Creating a `worker.ts` entry point that starts only
the BullMQ consumer is minimal work.

---

## 10. Redis Memory Ceiling

### The Problem

The `redis:7-alpine` container in `docker-compose.yml` has `appendonly yes` but
no `maxmemory` setting. A 5,000-recipient broadcast creates 5,000 BullMQ jobs,
each storing the job data, metadata, and retry state in Redis.

### Why It Matters

If multiple broadcasts are queued (one active, one pending), or if completed
jobs are not cleaned up, Redis memory grows without bound. On a host with
limited RAM, this can OOM-kill the container — and because `appendonly` is on,
the AOF file grows with it and delays the next restart.

### Resolution

1. **Set a memory ceiling**:

   ```yaml
   # docker-compose.yml
   redis:
     command:
       [
         'redis-server',
         '--appendonly',
         'yes',
         '--maxmemory',
         '256mb',
         '--maxmemory-policy',
         'noeviction',
       ]
   ```

   `noeviction` is correct for a queue: evicting a job mid-delivery is data
   loss. Instead, BullMQ throws when Redis is full, and the API returns 503
   naming the cause.

2. **Configure BullMQ job retention**:

   ```ts
   await queue.add('reminder-dm', data, {
     removeOnComplete: { age: 3600 }, // keep completed jobs for 1 hour
     removeOnFail: { age: 86400 }, // keep failed jobs for 1 day
   });
   ```

   Without this, every completed job stays in Redis forever.

---

## 11. Member Sync — Sequential Upserts

### The Problem

The Discord member sync fetches all guild members and upserts them one at a
time via Prisma. At 5,000 members per guild (10,000 total across 2 guilds),
this is 10,000 individual `INSERT ... ON CONFLICT UPDATE` queries executed
sequentially.

### Why It Matters

A full sync takes 30–60 seconds, during which it:

- Holds connection pool slots continuously
- Competes with attendance submissions for row-level locks on `discord_members`
- Generates significant WAL volume in Postgres

### Resolution

**Option A — Batch the upserts**:

Use `prisma.$executeRaw` with a multi-row `INSERT ... ON CONFLICT` to upsert
500 members per query instead of one at a time:

```sql
INSERT INTO discord_members (id, guild_id, discord_user_id, ...)
VALUES ($1, $2, $3, ...), ($4, $5, $6, ...), ...
ON CONFLICT (guild_id, discord_user_id)
DO UPDATE SET discord_username = EXCLUDED.discord_username, ...
```

This reduces 10,000 queries to 20.

**Option B — Use a temporary staging table**:

```sql
CREATE TEMP TABLE staging_members (LIKE discord_members);
COPY staging_members FROM STDIN;  -- bulk insert
INSERT INTO discord_members SELECT * FROM staging_members
ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET ...;
```

This is the fastest approach for bulk updates but requires raw SQL.

---

## 12. CSV Export — Unbounded Streaming

### The Problem

The CSV export in `dailyStatus.service.ts` streams in batches of 500, issuing
a paginated query per batch. At 10,000 members (2 guilds × 5,000), this is 20
sequential database queries plus the response streaming.

### Why It Matters

1. The 20 queries hold connection pool slots sequentially for the full export
   duration
2. Each query re-executes the same expensive raw SQL with different OFFSET
   values — and Postgres does not skip efficiently with OFFSET (it reads and
   discards all preceding rows)
3. A slow client (or a network hiccup) keeps the response stream open
   indefinitely, holding a connection

### Resolution

1. **Replace OFFSET pagination with cursor-based pagination**:
   Use the last row's sort key from each batch as the starting point for the
   next query, avoiding the O(n²) OFFSET problem.

2. **Set a response timeout** to prevent hanging exports:

   ```ts
   res.setTimeout(60000, () => {
     res.end();
   });
   ```

3. **Consider generating the CSV in a background job** and serving it from a
   file, rather than streaming live queries for each request.

---

## 13. Single-Process Architecture

### The Problem

The current architecture runs everything in one Node process:

- Express API server
- Discord bot (gateway connection)
- Channel scheduler (node-cron)
- Announcement scheduler (node-cron)
- BullMQ reminder worker

### Why It Matters

Node.js is single-threaded. A CPU spike in any one component (heavy JSON
parsing, a slow sync, GC pause) blocks all others. At 5,000 users, the
Express API alone can saturate a single core during peak attendance
submission.

### Resolution

The `.env` already has the flags for process separation:

| Process              | Flags                                                      |
| -------------------- | ---------------------------------------------------------- |
| **API**              | `SCHEDULER_ENABLED=false`, `REMINDER_WORKER_ENABLED=false` |
| **Bot + Schedulers** | `SCHEDULER_ENABLED=true`, does not listen on PORT          |
| **Worker**           | `REMINDER_WORKER_ENABLED=true`, does not listen on PORT    |

Implement this as separate Docker services or PM2 apps:

```yaml
# docker-compose.yml (production)
api:
  build: .
  environment:
    SCHEDULER_ENABLED: 'false'
    REMINDER_WORKER_ENABLED: 'false'
  ports: ['8000:8000']
  deploy:
    replicas: 2 # horizontal scaling

bot:
  build: .
  command: ['node', 'dist/src/bot.js'] # new entry point
  environment:
    SCHEDULER_ENABLED: 'true'
  deploy:
    replicas: 1 # exactly one

worker:
  build: .
  command: ['node', 'dist/src/worker.js'] # new entry point
  environment:
    REMINDER_WORKER_ENABLED: 'true'
  deploy:
    replicas: 1 # can scale if Redis rate limiter is shared
```

This requires creating `bot.ts` and `worker.ts` entry points — minimal work
since the startup logic is already modular.

---

## 14. Missing Health Check Endpoint

### The Problem

There is no `/health` or `/readiness` endpoint. The only way to check if the
server is alive is `GET /` which returns `Hello, World!` — it does not verify
database connectivity, Redis availability, or Discord bot status.

### Why It Matters

At scale with process separation and container orchestration, load balancers
and Docker health checks need a reliable signal to route traffic away from
unhealthy instances. Without it:

- A process with an exhausted connection pool still receives traffic
- A process whose Postgres connection dropped still reports as healthy

### Resolution

```ts
// src/routes/health.ts
app.get('/health', async (req, res) => {
  const checks = {
    database: false,
    redis: isRedisAvailable(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {}

  const healthy = checks.database; // Redis is optional
  res.status(healthy ? 200 : 503).json(checks);
});
```

Add a Docker healthcheck:

```yaml
api:
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:8000/health']
    interval: 10s
    timeout: 3s
    retries: 3
```

---

## 15. Summary — Priority Matrix

Items are ordered by severity and likelihood of impact at 5,000 users.

| #   | Bottleneck                                                                | Severity    | Effort | Priority                    |
| --- | ------------------------------------------------------------------------- | ----------- | ------ | --------------------------- |
| 1   | [Prisma connection pool](#1-prisma-connection-pool)                       | 🔴 Critical | Low    | **P0 — Do first**           |
| 2   | [PostgreSQL `max_connections`](#2-postgresql-max_connections)             | 🔴 Critical | Low    | **P0 — Do first**           |
| 7   | [Rate limiter NAT collisions](#7-rate-limiter--nat-collisions)            | 🔴 Critical | Low    | **P0 — Do first**           |
| 3   | [PostgreSQL memory tuning](#3-postgresql-memory-tuning)                   | 🟠 High     | Low    | **P1 — Before testing**     |
| 8   | [Attendance window cache](#8-attendance-window--missing-cache)            | 🟠 High     | Low    | **P1 — Before testing**     |
| 4   | [Attendance transaction contention](#4-attendance-transaction-contention) | 🟠 High     | Medium | **P1 — Before testing**     |
| 10  | [Redis memory ceiling](#10-redis-memory-ceiling)                          | 🟠 High     | Low    | **P1 — Before testing**     |
| 14  | [Health check endpoint](#14-missing-health-check-endpoint)                | 🟡 Medium   | Low    | **P2 — Before production**  |
| 5   | [Daily status SQL at scale](#5-daily-status-raw-sql-at-scale)             | 🟡 Medium   | Medium | **P2 — After test results** |
| 6   | [Rate limiter process-local store](#6-rate-limiter--process-local-store)  | 🟡 Medium   | Low    | **P2 — When multi-process** |
| 9   | [BullMQ event loop contention](#9-bullmq-worker--event-loop-contention)   | 🟡 Medium   | Medium | **P2 — After test results** |
| 11  | [Member sync sequential upserts](#11-member-sync--sequential-upserts)     | 🟡 Medium   | Medium | **P2 — After test results** |
| 12  | [CSV export unbounded streaming](#12-csv-export--unbounded-streaming)     | 🟡 Medium   | Medium | **P3 — Optimisation**       |
| 13  | [Single-process architecture](#13-single-process-architecture)            | 🟡 Medium   | High   | **P3 — Production scale**   |

### Quick Wins (< 1 hour each)

These four changes will have the largest impact with the least effort:

1. **Configure `pg.Pool` with `max: 30`** in `src/lib/prisma.ts`
2. **Set `max_connections=200`** in docker-compose Postgres command
3. **Add memory cache** to `getAttendanceWindow()` with 60 s TTL
4. **Set `maxmemory 256mb`** on the Redis container

### What to Defer

- Process separation (item 13) is architecture work — worth it for production
  but not needed to run stress tests
- Materialised views (item 5) should be informed by actual query timings from
  the stress test, not built speculatively
- OFFSET→cursor migration (item 12) only matters if the export is actually
  slow at scale
