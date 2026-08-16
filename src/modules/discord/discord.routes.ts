import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { discordController } from '@/modules/discord/discord.controller';

const router = express.Router();

// Get bot connection state, member counts & last sync summary
router.get(
  '/sync/status',
  auth(UserRole.ADMIN),
  discordController.getSyncStatus,
);

// Trigger a full guild member re-sync
router.post('/sync', auth(UserRole.ADMIN), discordController.triggerSync);

export const discordRouter: Router = router;
