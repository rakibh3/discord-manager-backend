import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  fetchGuild,
  getBotTag,
  getConfiguredGuilds,
  getGuildRuntimeStates,
  getIngestionState,
  isDiscordConnected,
} from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  getSyncState,
  isSyncRunning,
  syncGuildMembers,
} from '@/lib/discord/member.sync';
import { prisma } from '@/lib/prisma';

/**
 * Bot connection state, stored member counts, and the last sync outcome — all
 * reported PER CONFIGURED SERVER.
 *
 * The per-server breakdown is the point. A combined total would hide the two
 * conditions that actually need acting on: one server whose sync tripped its
 * departure guard, and one server whose channels failed ownership verification.
 * Both leave the other server looking perfectly healthy.
 */
const getSyncStatusFromDB = async () => {
  const runtimeStates = getGuildRuntimeStates();
  const ingestion = getIngestionState();

  const grouped = await prisma.discordMember.groupBy({
    by: ['guildId', 'isInGuild'],
    _count: { _all: true },
  });

  const countFor = (guildId: string, isInGuild: boolean): number =>
    grouped.find(
      (row) => row.guildId === guildId && row.isInGuild === isInGuild,
    )?._count._all ?? 0;

  const servers = runtimeStates.map((state) => {
    const { guildId } = state.config;
    const active = countFor(guildId, true);
    const departed = countFor(guildId, false);

    return {
      guildId,
      label: state.config.label ?? state.name ?? guildId,
      name: state.name,
      reachable: state.reachable,
      unreachableReason: state.unreachableReason,
      discordMemberCount: state.memberCount,
      members: { total: active + departed, active, departed },
      // Which of this server's channels resolve into this server. A failure
      // here is almost always a swapped or mistyped channel ID — and because
      // every server names its channels identically, this endpoint is the only
      // place it is visible.
      channels: {
        attendance: {
          id: state.config.channels.attendance,
          verified: state.channels.attendance === null,
          error: state.channels.attendance,
        },
        dailyUpdate: {
          id: state.config.channels.dailyUpdate,
          verified: state.channels.dailyUpdate === null,
          error: state.channels.dailyUpdate,
        },
        reminder: {
          id: state.config.channels.reminder,
          verified: state.channels.reminder === null,
          error: state.channels.reminder,
        },
      },
      verifiedAt: state.verifiedAt,
      lastSync: getSyncState(guildId),
    };
  });

  const totals = servers.reduce(
    (acc, server) => ({
      total: acc.total + server.members.total,
      active: acc.active + server.members.active,
      departed: acc.departed + server.members.departed,
    }),
    { total: 0, active: 0, departed: 0 },
  );

  return {
    bot: {
      connected: isDiscordConnected(),
      tag: getBotTag(),
      configuredServers: runtimeStates.length,
      reachableServers: runtimeStates.filter((state) => state.reachable).length,
    },
    members: totals,
    servers,
    // Reported rather than left to the logs on purpose: a bot that fell back to
    // a login without MessageContent looks entirely healthy from outside, and
    // the only other symptom is a month of missing daily updates. It is a
    // property of the CONNECTION, not of a server — the intent is refused for
    // the whole token — so it is reported once.
    dailyUpdate: {
      ingestionEnabled: ingestion.enabled,
      reason: ingestion.reason,
    },
  };
};

/** The configured servers, for a dashboard building a server filter. */
const listServers = () =>
  getGuildRuntimeStates().map((state) => ({
    guildId: state.config.guildId,
    label: guildLabel(state.config),
    name: state.name,
    reachable: state.reachable,
    unreachableReason: state.unreachableReason,
  }));

/**
 * Kicks off a full re-sync without blocking the response.
 *
 * Syncs every configured server by default; `guildId` narrows it to one. A
 * server whose sync is already running is skipped rather than refused, so one
 * busy server does not block the others — but naming a single busy server IS a
 * conflict, because the caller asked for that one specifically.
 */
const triggerMemberSync = async (guildId?: string) => {
  if (!isDiscordConnected()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Discord bot is not connected. Check DISCORD_BOT_TOKEN and the bot logs.',
    );
  }

  const configured = getConfiguredGuilds();

  if (guildId && !configured.some((guild) => guild.guildId === guildId)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Unknown server: ${guildId}. Configured servers are listed at GET /api/discord/servers.`,
    );
  }

  const targets = guildId
    ? configured.filter((guild) => guild.guildId === guildId)
    : configured;

  if (guildId && isSyncRunning(guildId)) {
    throw new AppError(
      httpStatus.CONFLICT,
      `A member sync is already running for server ${guildId}. Wait for it to finish before starting another.`,
    );
  }

  const accepted: string[] = [];
  const skipped: { guildId: string; reason: string }[] = [];

  for (const guild of targets) {
    if (isSyncRunning(guild.guildId)) {
      skipped.push({
        guildId: guild.guildId,
        reason: 'A sync is already running for this server',
      });
      continue;
    }

    const fetched = await fetchGuild(guild.guildId);

    if (!fetched) {
      skipped.push({
        guildId: guild.guildId,
        reason:
          'The guild could not be fetched. Check the ID and that the bot is a member of that server.',
      });
      continue;
    }

    // Not awaited: a full sync takes tens of seconds, far longer than a request.
    void syncGuildMembers(fetched);
    accepted.push(guild.guildId);
  }

  if (accepted.length === 0) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      `No server could be synced. ${skipped.map((s) => `${s.guildId}: ${s.reason}`).join('; ')}`,
    );
  }

  return { accepted, skipped, startedAt: new Date() };
};

export const discordService = {
  getSyncStatusFromDB,
  listServers,
  triggerMemberSync,
};
