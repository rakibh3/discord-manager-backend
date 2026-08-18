import type {
  AnnouncementLog,
  AnnouncementTemplate,
} from '@generated/prisma/client';
import type {
  AnnouncementStatus,
  AnnouncementTrigger,
} from '@generated/prisma/enums';

import { prisma } from '@/lib/prisma';
import { DEFAULT_ANNOUNCEMENT_BODY } from '@/utils/announcementTemplate';

/**
 * Data access for `announcement_templates` and `announcement_logs`.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. This lives in the repository layer rather than inside the
 * announcement module because its readers are not all HTTP-scoped — the cron
 * task loads the template from a `node-cron` callback with no request in sight,
 * and must run the same queries the admin endpoints do.
 *
 * P2002 from `claimDay` is deliberately allowed to propagate. Whether "the day
 * is already taken" is a 409, a silent skip, or a retry depends entirely on who
 * is asking, and that decision belongs to the caller.
 */

/** The only key in use today. See the model comment on `key`. */
export const ATTENDANCE_ANNOUNCEMENT_KEY = 'ATTENDANCE_DAILY';

/**
 * What the row is born with: the message the program posts by hand today, at
 * 7 PM Dhaka, every day, with nothing mentioned.
 *
 * An empty mention allowlist and `mentionEveryone: false` are the safe start —
 * the first automated post notifies nobody until an admin decides who it should
 * reach. `terminationDays: 3` matches the current policy in the message.
 */
export const DEFAULT_ANNOUNCEMENT = {
  body: DEFAULT_ANNOUNCEMENT_BODY,
  terminationDays: 3,
  mentionEveryone: false,
  mentionRoleIds: [] as string[],
  mentionUsernames: [] as string[],
  announceTime: '19:00',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
};

/** The stored row plus the admin who last touched it, for the read payload. */
export type TAnnouncementTemplateWithEditor = AnnouncementTemplate & {
  updatedBy: { id: string; name: string; email: string } | null;
};

const editorSelect = {
  updatedBy: { select: { id: true, name: true, email: true } },
};

/**
 * The announcement template, created with the defaults on first access.
 *
 * An upsert rather than a find-then-create, for the same reason
 * `getOrCreateSchedule()` is one: the cron task and a dashboard request can
 * easily arrive together on a cold deployment, and two concurrent
 * find-then-creates would both see no row and both insert. The unique index on
 * `key` makes the upsert the only version that cannot produce a duplicate.
 *
 * `update: {}` is deliberate — an existing row comes back untouched, so this can
 * be called on every tick without rewriting `updatedAt` and making the audit
 * field lie about when an admin last changed the message.
 */
const getOrCreateTemplate =
  async (): Promise<TAnnouncementTemplateWithEditor> =>
    prisma.announcementTemplate.upsert({
      where: { key: ATTENDANCE_ANNOUNCEMENT_KEY },
      update: {},
      create: { key: ATTENDANCE_ANNOUNCEMENT_KEY, ...DEFAULT_ANNOUNCEMENT },
      include: editorSelect,
    });

export type TUpdateAnnouncementInput = {
  body?: string;
  terminationDays?: number;
  mentionEveryone?: boolean;
  mentionRoleIds?: string[];
  /** Normalized, lowercased handles. Validate with `DISCORD_USERNAME_REGEX`. */
  mentionUsernames?: string[];
  /** `HH:mm`, Asia/Dhaka. Validate with `timeOfDaySchema`. */
  announceTime?: string;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek?: number[];
  enabled?: boolean;
  /** The admin making the change; recorded for the audit. */
  updatedById: string;
};

/**
 * Applies a partial change to the template.
 *
 * Whether the result is coherent — a body that renders inside Discord's limit,
 * only supported placeholders, at least one weekday — is settled by the service
 * before this is called. This layer stores what it is given.
 */
const updateTemplate = async ({
  updatedById,
  ...fields
}: TUpdateAnnouncementInput): Promise<TAnnouncementTemplateWithEditor> =>
  prisma.announcementTemplate.update({
    where: { key: ATTENDANCE_ANNOUNCEMENT_KEY },
    data: { ...fields, updatedById },
    include: editorSelect,
  });

export type TClaimDayInput = {
  /** The server this attempt posts to. The claim is per server. */
  guildId: string;
  announcementDate: string;
  attempt: number;
  trigger: AnnouncementTrigger;
  renderedMessage: string;
  triggeredById?: string | null;
};

/**
 * Takes the day, as a `SENDING` row.
 *
 * The claim is the insert. A P2002 here means another caller already holds this
 * `(guild, key, date, attempt)` — propagated rather than swallowed, because a
 * cron task treats it as "nothing to do" and a manual send treats it as a 409,
 * and this layer has no way to tell which one is calling.
 *
 * Scoped per server: the question is "has THIS server been posted to today",
 * and a global claim would let a failure in one server silently consume the
 * other's day.
 */
const claimDay = async ({
  guildId,
  announcementDate,
  attempt,
  trigger,
  renderedMessage,
  triggeredById,
}: TClaimDayInput): Promise<AnnouncementLog> =>
  prisma.announcementLog.create({
    data: {
      guildId,
      key: ATTENDANCE_ANNOUNCEMENT_KEY,
      announcementDate,
      attempt,
      status: 'SENDING',
      trigger,
      renderedMessage,
      triggeredById: triggeredById ?? null,
    },
  });

export type TReclaimFailedDayInput = {
  guildId: string;
  announcementDate: string;
  attempt: number;
  trigger: AnnouncementTrigger;
  renderedMessage: string;
  triggeredById?: string | null;
};

/**
 * Re-takes a day whose previous attempt failed, so a failure does not consume
 * it.
 *
 * Scoped to `status: 'FAILED'` and returns the updated count, the same
 * scoped-claim trick as `markReminderProcessing`. Zero rows updated means
 * another caller got there first — either a retry that is already in flight
 * (`SENDING`) or one that has since succeeded (`POSTED`) — and the caller must
 * back off rather than post a second message.
 */
const reclaimFailedDay = async ({
  guildId,
  announcementDate,
  attempt,
  trigger,
  renderedMessage,
  triggeredById,
}: TReclaimFailedDayInput): Promise<number> => {
  const result = await prisma.announcementLog.updateMany({
    where: {
      guildId,
      key: ATTENDANCE_ANNOUNCEMENT_KEY,
      announcementDate,
      attempt,
      status: 'FAILED',
    },
    data: {
      status: 'SENDING',
      trigger,
      renderedMessage,
      triggeredById: triggeredById ?? null,
      error: null,
    },
  });

  return result.count;
};

export type TMarkPostedInput = {
  id: string;
  discordMessageId: string;
  mentionedRoleIds: string[];
  mentionedUserIds: string[];
  unresolvedTargets: string[];
};

const markPosted = async ({
  id,
  ...fields
}: TMarkPostedInput): Promise<AnnouncementLog> =>
  prisma.announcementLog.update({
    where: { id },
    data: { ...fields, status: 'POSTED', error: null },
  });

const markFailed = async (
  id: string,
  error: string,
): Promise<AnnouncementLog> =>
  prisma.announcementLog.update({
    where: { id },
    data: { status: 'FAILED', error },
  });

/** Every attempt recorded for a Dhaka date, newest attempt first. */
const findLogsForDate = async (
  announcementDate: string,
  guildId?: string,
): Promise<AnnouncementLog[]> =>
  prisma.announcementLog.findMany({
    where: {
      key: ATTENDANCE_ANNOUNCEMENT_KEY,
      announcementDate,
      ...(guildId ? { guildId } : {}),
    },
    orderBy: [{ guildId: 'asc' }, { attempt: 'desc' }],
  });

/** The single row holding a given attempt, or `null`. */
const findAttempt = async (
  guildId: string,
  announcementDate: string,
  attempt: number,
): Promise<AnnouncementLog | null> =>
  prisma.announcementLog.findUnique({
    where: {
      guildId_key_announcementDate_attempt: {
        guildId,
        key: ATTENDANCE_ANNOUNCEMENT_KEY,
        announcementDate,
        attempt,
      },
    },
  });

/**
 * The attempt number a forced second post should take.
 *
 * Safe to be non-atomic: two callers reading the same number both try to insert
 * it, and the unique constraint turns the loser into a reported conflict rather
 * than a duplicate message.
 */
const nextAttemptNumber = async (
  guildId: string,
  announcementDate: string,
): Promise<number> => {
  const latest = await prisma.announcementLog.findFirst({
    where: { guildId, key: ATTENDANCE_ANNOUNCEMENT_KEY, announcementDate },
    orderBy: { attempt: 'desc' },
    select: { attempt: true },
  });

  return (latest?.attempt ?? 0) + 1;
};

/** The most recent attempt on any day, for the status payload. */
const findLastLog = async (guildId?: string): Promise<AnnouncementLog | null> =>
  prisma.announcementLog.findFirst({
    where: {
      key: ATTENDANCE_ANNOUNCEMENT_KEY,
      ...(guildId ? { guildId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

export type { AnnouncementLog, AnnouncementStatus };

export const announcementRepository = {
  getOrCreateTemplate,
  updateTemplate,
  claimDay,
  reclaimFailedDay,
  markPosted,
  markFailed,
  findLogsForDate,
  findAttempt,
  nextAttemptNumber,
  findLastLog,
};
