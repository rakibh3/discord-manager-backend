import type { RosterEntry, RosterSetting } from '@generated/prisma/client';
import { Prisma } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Data access for the enrolment roster.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. This file returns data, `null`, or a plain result object;
 * deciding that a miss is a 403 belongs to the calling service.
 *
 * It lives in `src/repositories/` rather than inside the roster module because
 * its readers are not all one module's: `attendance.service.ts` reads
 * `findActiveEntryByEmail` and `getOrCreateSettings` on the public submit path,
 * and the attendance domain already routes its data access through this layer
 * precisely so two definitions of the same question cannot drift. "Is this
 * address enrolled" must have exactly one implementation.
 */

/** The only settings key in use today. See the model comment on `key`. */
export const ROSTER_SETTINGS_KEY = 'ATTENDANCE_ROSTER';

/** How many rows are written per transaction. Matches `member.sync.ts`. */
export const ROSTER_UPSERT_CHUNK_SIZE = 200;

/**
 * The active entry holding this address, or `null`.
 *
 * Expects an ALREADY-NORMALIZED address — `normalizeRosterEmail` output. The
 * column stores only that form, so an exact match is both correct and served by
 * the unique index.
 *
 * Never `startsWith` / `contains`, which compile to SQL `LIKE`, where `_` is a
 * single-character wildcard and `%` matches anything — against a column full of
 * addresses containing dots and underscores that would match a large part of
 * the roster and admit people who are not on it.
 *
 * `isActive: true` is part of the query rather than a check in the caller, so
 * "no such entry" and "entry exists but was removed" collapse into one result.
 * That collapse is deliberate and mirrors `findActiveMembersByUsername`: both
 * produce the same refusal, and keeping them indistinguishable means the submit
 * endpoint cannot be used to learn that a particular address used to be on the
 * roll.
 *
 * Reads the roster and nothing else — no Discord call, no member directory
 * lookup, no dependence on how many servers are configured.
 */
const findActiveEntryByEmail = async (
  normalizedEmail: string,
): Promise<RosterEntry | null> =>
  prisma.rosterEntry.findFirst({
    where: { email: normalizedEmail, isActive: true },
  });

/** How many people are currently enrolled. Backs the arming guard. */
const countActiveEntries = async (): Promise<number> =>
  prisma.rosterEntry.count({ where: { isActive: true } });

/** One validated spreadsheet row, ready to write. */
export type TRosterUpsertRow = {
  /** Already normalized. */
  email: string;
  name: string;
  phone: string | null;
};

export type TUpsertChunkOutcome = {
  created: number;
  updated: number;
  /** Rows in chunks that failed to commit, and why. */
  failed: number;
  failures: { size: number; reason: string }[];
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * Writes the imported rows, upserting on the normalized email.
 *
 * Chunked into transactions of 200 for the same reason `member.sync.ts` is: one
 * transaction spanning a whole roster holds locks on a table the public
 * attendance form reads on every submission, and a failure near the end would
 * discard everything already loaded.
 *
 * An update forces `isActive: true`, which is what makes re-importing a
 * mistakenly removed person an ordinary import rather than an administrative
 * repair.
 *
 * There is deliberately no delete and no deactivate anywhere in this function.
 * An import can only add and correct. A full-replace import would need a
 * departure-guard-style safety threshold to be survivable — and getting mass
 * deactivation wrong here is invisible, because with enforcement on the only
 * symptom is students being refused. Making the import purely additive removes
 * the whole class of failure: the worst outcome of a wrong file is extra people
 * on the roll, which refuses nobody.
 *
 * **The `update` payload below names ONLY `name`, `phone`, and `isActive`. It
 * MUST NOT name `discordUserId` or `linkedAt`.** A routine re-import would
 * otherwise erase every learned pairing in bulk — the highest-consequence
 * failure in this feature, silent, no error raised anywhere, and the only
 * symptom a report that suddenly shows the whole roster as unreachable. New
 * rows are created with both link fields NULL so the import never sources a
 * pairing from the sheet either.
 *
 * Never throws. A chunk that fails is counted and reported so the caller can
 * put it in the summary; the remaining chunks still run, because a partial
 * import is a success and the rows that did land really did land.
 */
const upsertEntriesInChunks = async (
  rows: TRosterUpsertRow[],
  chunkSize: number = ROSTER_UPSERT_CHUNK_SIZE,
): Promise<TUpsertChunkOutcome> => {
  const outcome: TUpsertChunkOutcome = {
    created: 0,
    updated: 0,
    failed: 0,
    failures: [],
  };

  for (const batch of chunk(rows, chunkSize)) {
    // Which addresses already exist decides created-versus-updated. Read inside
    // the loop rather than once up front so the counts stay accurate if the
    // same import is racing another write.
    const emails = batch.map((row) => row.email);

    try {
      const existing = await prisma.rosterEntry.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      });
      const existingEmails = new Set(existing.map((row) => row.email));

      await prisma.$transaction(
        batch.map((row) =>
          prisma.rosterEntry.upsert({
            where: { email: row.email },
            update: {
              name: row.name,
              phone: row.phone,
              // Re-importing someone reinstates them.
              isActive: true,
              // FORBIDDEN: discordUserId, linkedAt. See header comment.
            },
            create: {
              email: row.email,
              name: row.name,
              phone: row.phone,
              // FORBIDDEN: discordUserId, linkedAt — imports never source a
              // pairing from the sheet.
            },
          }),
        ),
      );

      for (const row of batch) {
        if (existingEmails.has(row.email)) outcome.updated += 1;
        else outcome.created += 1;
      }
    } catch (error) {
      outcome.failed += batch.length;
      outcome.failures.push({
        size: batch.length,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return outcome;
};

export type TListEntriesQuery = {
  search?: string;
  /** `active` | `inactive` | `all`. */
  status: 'active' | 'inactive' | 'all';
  page: number;
  limit: number;
};

export type TListEntriesResult = {
  entries: RosterEntry[];
  total: number;
};

/**
 * A page of roster entries plus the total matching the same filter.
 *
 * The search is a case-insensitive `contains` across name and email. That is
 * the one place in this file where `LIKE` semantics are correct: this is an
 * admin browsing their own roster, not an authorization decision, and matching
 * too broadly here shows an extra row rather than admitting an extra person.
 */
const listEntries = async (
  query: TListEntriesQuery,
): Promise<TListEntriesResult> => {
  const where: Prisma.RosterEntryWhereInput = {};

  if (query.status !== 'all') where.isActive = query.status === 'active';

  if (query.search?.trim()) {
    const search = query.search.trim();
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [entries, total] = await Promise.all([
    prisma.rosterEntry.findMany({
      where,
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.rosterEntry.count({ where }),
  ]);

  return { entries, total };
};

const findEntryById = async (id: string): Promise<RosterEntry | null> =>
  prisma.rosterEntry.findUnique({ where: { id } });

export type TUpdateEntryInput = {
  /** Already normalized when present. */
  email?: string;
  name?: string;
  phone?: string | null;
};

/**
 * Corrects one entry. Throws P2002 when the new address is held by another
 * entry — translating that into a 409 is the service's job.
 */
const updateEntry = async (
  id: string,
  input: TUpdateEntryInput,
): Promise<RosterEntry> =>
  prisma.rosterEntry.update({ where: { id }, data: input });

/**
 * Record the pairing between an enrolled email address and a Discord account.
 *
 * One `updateMany` scoped `{ email, isActive: true, discordUserId: null }` —
 * the `discordUserId: null` in the WHERE is the CLAIM, not a precondition.
 * Same scoped-claim shape as `markReminderProcessing` (scoped to `PENDING`)
 * and `reclaimFailedDay` (scoped to `FAILED`): a read-then-write "is it
 * already linked?" check does not survive two students submitting in the same
 * millisecond, and this is a path that sees a burst every evening.
 *
 * The companion `@unique` on `discord_user_id` handles the other direction:
 * an account already linked to a *different* entry raises P2002, which is
 * caught and translated to `claimed: false` rather than surfaced as an error —
 * the account already belongs to another entry, which is a determination, not
 * a failure. Without that translation the catch in the caller would have to
 * know that P2002 here is a routine answer; better to handle it where it is
 * caught.
 *
 * Returns whether a row was claimed. The caller (the attendance submit
 * service) wraps this in a try/catch that swallows every other error so the
 * pairing can never refuse or delay the submission.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. The boolean is the whole contract.
 */
const linkEntryToAccount = async ({
  normalizedEmail,
  discordUserId,
}: {
  normalizedEmail: string;
  discordUserId: string;
}): Promise<{ claimed: boolean }> => {
  try {
    const result = await prisma.rosterEntry.updateMany({
      where: {
        email: normalizedEmail,
        isActive: true,
        discordUserId: null,
      },
      data: {
        discordUserId,
        linkedAt: new Date(),
      },
    });

    return { claimed: result.count > 0 };
  } catch (error) {
    // P2002 = the unique on `discord_user_id` fired: the account is already
    // linked to a different entry. That is a determination, not an error.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      JSON.stringify(error.meta ?? {}).includes('discord_user_id')
    ) {
      return { claimed: false };
    }

    throw error;
  }
};

/** Deactivate or reinstate. Never a delete — history keeps its row. */
const setEntryActive = async (
  id: string,
  isActive: boolean,
): Promise<RosterEntry> =>
  prisma.rosterEntry.update({ where: { id }, data: { isActive } });

export type TCreateImportRecord = {
  fileName: string;
  importedById: string | null;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  duplicateCount: number;
};

const createImportRecord = async (input: TCreateImportRecord) =>
  prisma.rosterImport.create({ data: input });

const importerSelect = {
  importedBy: { select: { id: true, name: true, email: true } },
};

const listImports = async ({
  page,
  limit,
}: {
  page: number;
  limit: number;
}) => {
  const [imports, total] = await Promise.all([
    prisma.rosterImport.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: importerSelect,
    }),
    prisma.rosterImport.count(),
  ]);

  return { imports, total };
};

/** The stored settings row plus the admin who last touched it. */
export type TRosterSettingWithEditor = RosterSetting & {
  updatedBy: { id: string; name: string; email: string } | null;
};

/**
 * The enforcement setting, created disabled on first access.
 *
 * An upsert rather than find-then-create, for the reason `getOrCreateSchedule`
 * is one: the row is materialized lazily, and a dashboard read can easily
 * arrive alongside a student's submission on a cold deployment. Two concurrent
 * find-then-creates would both see nothing and both insert.
 *
 * `update: {}` leaves an existing row untouched, so calling this on every
 * submission does not rewrite `updatedAt` and make the audit field lie about
 * when an admin last changed something.
 */
const getOrCreateSettings = async (): Promise<TRosterSettingWithEditor> =>
  prisma.rosterSetting.upsert({
    where: { key: ROSTER_SETTINGS_KEY },
    update: {},
    create: { key: ROSTER_SETTINGS_KEY },
    include: { updatedBy: { select: { id: true, name: true, email: true } } },
  });

const updateSettings = async ({
  enforceEmail,
  updatedById,
}: {
  enforceEmail: boolean;
  updatedById: string;
}): Promise<TRosterSettingWithEditor> =>
  prisma.rosterSetting.upsert({
    where: { key: ROSTER_SETTINGS_KEY },
    update: { enforceEmail, updatedById },
    create: { key: ROSTER_SETTINGS_KEY, enforceEmail, updatedById },
    include: { updatedBy: { select: { id: true, name: true, email: true } } },
  });

export const rosterRepository = {
  findActiveEntryByEmail,
  countActiveEntries,
  upsertEntriesInChunks,
  listEntries,
  findEntryById,
  updateEntry,
  setEntryActive,
  linkEntryToAccount,
  createImportRecord,
  listImports,
  getOrCreateSettings,
  updateSettings,
};
