/**
 * Verification harness for the roster ↔ Discord pairing change.
 *
 * Exercises the new repository functions and the validation surface against a
 * local database to confirm the four invariants the change rests on:
 *
 *   1. First-write-wins for the pairing — two accepted submissions carrying
 *      the same enrolled address and different accounts do not overwrite each
 *      other; the unique constraint catches the second.
 *   2. Importing a sheet that already contains a paired entry leaves the
 *      pairing intact and only updates the name and phone.
 *   3. Engagement figures reconcile: paired + unpaired equals enrolled; the
 *      paired status buckets sum to paired.
 *   4. A range beyond 92 days is refused; a weekday set that leaves zero
 *      counted days is refused.
 *
 * Not run by `bun test` (none configured); invoked by hand to verify the
 * change before /archive.
 */
import 'dotenv/config';

import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { rosterRepository } from './src/repositories/roster.repository';
import { rosterStatusRepository } from './src/repositories/rosterStatus.repository';

const connectionString = `${process.env.DATABASE_URL}`;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const createdEntryIds: string[] = [];
const createdMemberIds: string[] = [];

const cleanup = async (): Promise<void> => {
  for (const id of createdEntryIds) {
    await prisma.rosterEntry.delete({ where: { id } }).catch(() => {});
  }
  for (const id of createdMemberIds) {
    await prisma.discordMember.delete({ where: { id } }).catch(() => {});
  }

  await prisma.$disconnect();
};

const log = (label: string, ok: boolean, detail = ''): void => {
  const prefix = ok ? 'OK ' : 'FAIL';
  console.log(`${prefix}  ${label}${detail ? `: ${detail}` : ''}`);
};

async function main(): Promise<void> {
  // ── Setup: two enrolled entries, one Discord member ──────────────────────
  const entryA = await prisma.rosterEntry.create({
    data: { email: `verify-a-${Date.now()}@example.com`, name: 'Verify A', phone: '01700000001' },
  });
  const entryB = await prisma.rosterEntry.create({
    data: { email: `verify-b-${Date.now()}@example.com`, name: 'Verify B', phone: '01700000002' },
  });
  const entryC = await prisma.rosterEntry.create({
    data: { email: `verify-c-${Date.now()}@example.com`, name: 'Verify C', phone: '01700000003' },
  });
  createdEntryIds.push(entryA.id, entryB.id, entryC.id);

  const discordUserA = '100000000000000001';
  const discordUserB = '100000000000000002';

  const member = await prisma.discordMember.create({
    data: {
      guildId: '111111111111111111',
      discordUserId: discordUserA,
      discordUsername: 'verifya',
      displayName: 'Verify A',
      isInGuild: true,
    },
  });
  createdMemberIds.push(member.id);

  // ── 10.1 First submission pairs the entry ────────────────────────────────
  const first = await rosterRepository.linkEntryToAccount({
    normalizedEmail: entryA.email,
    discordUserId: discordUserA,
  });
  log('10.1 first accepted submission pairs the entry', first.claimed);

  // ── 10.2 Same account submits under a different enrolled address ─────────
  // Neither entry is paired; both stay unpaired.
  const secondA = await rosterRepository.linkEntryToAccount({
    normalizedEmail: entryB.email,
    discordUserId: discordUserA,
  });
  log('10.2a account submitting under second address: claimed', !secondA.claimed);

  // entry A still has its pairing
  const stillA = await prisma.rosterEntry.findUnique({ where: { id: entryA.id } });
  log(
    '10.2b entry A still paired',
    stillA?.discordUserId === discordUserA,
    `discordUserId=${stillA?.discordUserId ?? 'null'}`,
  );

  // entry B remains unpaired
  const stillB = await prisma.rosterEntry.findUnique({ where: { id: entryB.id } });
  log(
    '10.2c entry B remains unpaired',
    stillB?.discordUserId === null,
    `discordUserId=${stillB?.discordUserId ?? 'null'}`,
  );

  // ── 10.3 Second account submits under an already-paired address ──────────
  const third = await rosterRepository.linkEntryToAccount({
    normalizedEmail: entryA.email,
    discordUserId: discordUserB,
  });
  log('10.3 second account claims paired address: not claimed', !third.claimed);

  // entry A still paired to the original account
  const stillAPaired = await prisma.rosterEntry.findUnique({ where: { id: entryA.id } });
  log(
    '10.3b pairing unchanged',
    stillAPaired?.discordUserId === discordUserA,
    `discordUserId=${stillAPaired?.discordUserId ?? 'null'}`,
  );

  // ── 10.4 Re-importing the sheet preserves pairings ───────────────────────
  // We can't drive the full import through the controller, but the repository's
  // upsertEntriesInChunks must not touch the link fields. Simulate it.
  await rosterRepository.upsertEntriesInChunks([
    { email: entryA.email, name: 'Verify A (renamed)', phone: '01700000099' },
  ]);
  const afterImport = await prisma.rosterEntry.findUnique({ where: { id: entryA.id } });
  log(
    '10.4a name updated',
    afterImport?.name === 'Verify A (renamed)',
    `name=${afterImport?.name ?? 'null'}`,
  );
  log(
    '10.4b phone updated',
    afterImport?.phone === '01700000099',
    `phone=${afterImport?.phone ?? 'null'}`,
  );
  log(
    '10.4c pairing preserved',
    afterImport?.discordUserId === discordUserA,
    `discordUserId=${afterImport?.discordUserId ?? 'null'}`,
  );

  // ── 10.5 NEVER_LINKED for an enrolled person who never submitted ─────────
  const today = new Date().toISOString().slice(0, 10);
  const counts = await rosterStatusRepository.getRosterStatusCounts(today);
  log(
    '10.5a enrolled >= 3 (this run added 3)',
    counts.enrolled >= 3,
    `enrolled=${counts.enrolled}`,
  );
  log(
    '10.5b paired + unpaired == enrolled',
    counts.paired + counts.unpaired === counts.enrolled,
    `paired=${counts.paired} unpaired=${counts.unpaired} enrolled=${counts.enrolled}`,
  );
  log(
    '10.5c paired buckets sum to paired',
    counts.bothComplete +
      counts.missingUpdateOnly +
      counts.missingAttendanceOnly +
      counts.missingBoth ===
      counts.paired,
    `sum=${counts.bothComplete + counts.missingUpdateOnly + counts.missingAttendanceOnly + counts.missingBoth} paired=${counts.paired}`,
  );

  // ── 10.7 Range wider than 92 days is a 400, weekday set with zero days is a 400 ──
  // The 92-day cap lives in the Zod validator; the zero-weekday refusal lives
  // in `resolveRosterStatusPeriod` (an `AppError`). Exercise both.
  const { rosterService } = await import('./src/modules/roster/roster.service');
  const { rosterValidation } = await import('./src/modules/roster/roster.validation');
  const httpStatus = (await import('http-status')).default;
  const AppError = (await import('./src/errors/AppError')).default;

  const hugeQuery = rosterValidation.statusCountsQuerySchema.safeParse({
    from: '2020-01-01',
    to: '2025-01-01',
  });
  log(
    '10.7a range wider than 92 days: 400 at validation',
    !hugeQuery.success,
    `ok=${hugeQuery.success}`,
  );

  // A single-day range with a weekday set that excludes that day — the spec
  // case where every day is filtered out. `2026-08-21` is Friday (weekday 5).
  const dayWeekday = new Date(Date.UTC(2026, 7, 21)).getUTCDay();
  const matchingQuery = rosterValidation.statusCountsQuerySchema.safeParse({
    from: '2026-08-21',
    to: '2026-08-21',
    daysOfWeek: [0, 1, 2, 3, 4, 6].join(','),
  });
  log(
    '10.7b weekday set excluding all days: validation passes',
    matchingQuery.success && dayWeekday === 5,
    `ok=${matchingQuery.success} weekday=${dayWeekday}`,
  );

  if (matchingQuery.success) {
    try {
      await rosterService.getStatusCounts(matchingQuery.data);
      log('10.7c weekday set excluding all days: throws AppError', false, 'did not throw');
    } catch (error) {
      const isAppError = error instanceof AppError;
      const is400 = isAppError && error.statusCode === httpStatus.BAD_REQUEST;
      log('10.7c weekday set excluding all days: AppError 400', is400, `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await cleanup();
}

main().catch(async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});