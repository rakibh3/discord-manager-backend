import type { Server } from 'http';

import app from '@/app';
import {
  onDiscordReady,
  startDiscordBot,
  stopDiscordBot,
} from '@/lib/discord/client';
import { prisma } from '@/lib/prisma';
import { closeRedis, connectRedis } from '@/lib/queue/connection';
import { closeReminderQueue } from '@/lib/queue/reminder.queue';
import {
  startReminderWorker,
  stopReminderWorker,
} from '@/lib/queue/reminder.worker';
import {
  startAnnouncementScheduler,
  stopAnnouncementScheduler,
} from '@/lib/scheduler/announcement.scheduler';
import {
  startChannelScheduler,
  stopChannelScheduler,
} from '@/lib/scheduler/channelSchedule.scheduler';
import { createLogger } from '@/utils/logger';

const logger = createLogger('Server');

const PORT = process.env.PORT || 3000;

let server: Server | null = null;
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`${signal} received, shutting down...`);

  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });

  // Both before the client is destroyed, so nothing fires into a dying
  // connection. The worker is closed rather than killed: `close()` lets a DM
  // already in flight finish, and anything still queued stays in Redis for the
  // next process to pick up.
  await stopChannelScheduler();
  await stopAnnouncementScheduler();
  await stopReminderWorker();
  await stopDiscordBot();

  // Redis last of the queue pieces — the worker and queue both hold it.
  await closeReminderQueue();
  await closeRedis();

  await prisma.$disconnect();

  logger.info('Shutdown complete');
  process.exit(0);
};

async function main() {
  try {
    await prisma.$connect();
    logger.info('Connected to the database successfully.');

    server = app.listen(PORT, () => {
      logger.info(`Server is running on http://localhost:${PORT}`);
    });

    // Redis backs the reminder queue and nothing else, so this is reported and
    // never fatal: with it down the API, the bot, ingestion, and the scheduler
    // all run normally and only reminder broadcasts are refused.
    void connectRedis().then((connected) => {
      if (!connected) {
        logger.warn(
          'Redis is not reachable. Reminder broadcasts will be refused; everything else is unaffected.',
        );
      }
    });

    // Started after listen() and not awaited: the initial member fetch takes
    // tens of seconds and must never delay the API becoming ready. Failures
    // are handled inside startDiscordBot, which is why nothing escapes here.
    void startDiscordBot()
      .then((started) => {
        // The scheduler edits a channel, so it needs a live gateway connection.
        // A bot that never connected gets no jobs at all rather than jobs that
        // fail every night — `getSchedulerState()` then reports it as not
        // running, which is the honest answer.
        if (!started) {
          logger.warn(
            'Channel scheduler, announcement scheduler and reminder worker not started: the Discord bot is not running.',
          );
          return;
        }

        onDiscordReady(() => {
          void startChannelScheduler();

          // Its own call and its own catch: the announcement and the open/lock
          // window are independent features that happen to run at the same
          // hour, and a failure to register one must not stop the other from
          // running tonight.
          void startAnnouncementScheduler().catch((error) => {
            logger.error(
              'Announcement scheduler failed to start; everything else continues:',
              error,
            );
          });

          // A job cannot deliver a DM without a connected client, so the worker
          // waits for the same signal. Starting it earlier would only pull jobs
          // it could not execute and burn their retry attempts.
          startReminderWorker();
        });
      })
      .catch((error) => {
        logger.error(
          'Discord bot failed to start; API continues serving:',
          error,
        );
      });

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error('An error occurred:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
