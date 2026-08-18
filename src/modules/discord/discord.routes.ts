import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateRequest } from '@/middlewares/validateRequest';
import { discordController } from '@/modules/discord/discord.controller';
import { discordValidation } from '@/modules/discord/discord.validation';

const router = express.Router();

// Get bot connection state, member counts & last sync summary
router.get(
  '/sync/status',
  auth(UserRole.ADMIN),
  discordController.getSyncStatus,
);

// The configured servers and whether the bot currently reaches each
router.get('/servers', auth(UserRole.ADMIN), discordController.listServers);

// Trigger a full member re-sync. Every configured server, or one named one.
router.post(
  '/sync',
  auth(UserRole.ADMIN),
  validateRequest(discordValidation.triggerSyncValidationSchema),
  discordController.triggerSync,
);

export const discordRouter: Router = router;
