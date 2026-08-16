import 'dotenv/config';

import { UserRole, UserStatus } from '@generated/prisma/client';
import bcrypt from 'bcrypt';

import config from '@/config';
import { prisma } from '@/lib/prisma';

export interface AdminSeedInput {
  email: string;
  name?: string;
  phone?: string;
  password?: string;
  bio?: string;
  profilePhoto?: string;
  address?: string;
}

/**
 * Seeds administrator accounts into the database based on environment configuration or custom input.
 * No default/fallback admin accounts will be created if none are configured.
 *
 * @param customAdmins - Optional array of custom admin credentials to seed.
 */
export async function seedAdmins(customAdmins?: AdminSeedInput[]) {
  const adminPassword = config.admin.password;
  const adminName = config.admin.name || 'System Administrator';
  const saltRounds = Number(config.bcrypt_salt_rounds) || 9;

  // Build target list from custom admins or configured emails
  const targetAdmins: AdminSeedInput[] =
    customAdmins && customAdmins.length > 0
      ? customAdmins
      : config.admin.emails.map((email) => ({
          email,
          name: adminName,
          password: adminPassword,
          bio: 'System Administrator',
        }));

  if (targetAdmins.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[Seed] No admin accounts configured in environment (ADMIN_EMAIL / ADMIN_EMAILS). Skipping admin seeding.',
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[Seed] Starting admin seeding for ${targetAdmins.length} account(s)...`,
  );

  let createdCount = 0;
  let skippedCount = 0;

  for (const adminInput of targetAdmins) {
    const email = adminInput.email.trim().toLowerCase();
    const name = adminInput.name?.trim() || adminName;
    const phone = adminInput.phone?.trim() || undefined;
    const password = adminInput.password || adminPassword;
    const bio = adminInput.bio || 'System Administrator';
    const profilePhoto = adminInput.profilePhoto || undefined;
    const address = adminInput.address || undefined;

    if (!email) {
      continue;
    }

    if (!password) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Seed] No password specified for admin (${email}). Skipping. Please set ADMIN_PASSWORD in your environment.`,
      );
      skippedCount++;
      continue;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      // eslint-disable-next-line no-console
      console.log(`[Seed] Admin already exists (${email}). Skipping.`);
      skippedCount++;
      continue;
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    await prisma.user.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        profile: {
          create: {
            bio,
            profilePhoto,
            address,
          },
        },
      },
    });

    // eslint-disable-next-line no-console
    console.log(`[Seed] Successfully created admin: ${email}`);
    createdCount++;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[Seed] Finished admin seeding. Total: ${targetAdmins.length}, Created: ${createdCount}, Skipped: ${skippedCount}.`,
  );
}

// Execute when run directly via CLI (tsx prisma/seed.ts)
seedAdmins()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error('[Seed] Error during admin seeding:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
