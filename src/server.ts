import type { Server } from 'http';

import app from '@/app';
import { startDiscordBot, stopDiscordBot } from '@/lib/discord/client';
import { prisma } from '@/lib/prisma';
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

  await stopDiscordBot();
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

    // Started after listen() and not awaited: the initial member fetch takes
    // tens of seconds and must never delay the API becoming ready. Failures
    // are handled inside startDiscordBot, which is why nothing escapes here.
    void startDiscordBot().catch((error) => {
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
