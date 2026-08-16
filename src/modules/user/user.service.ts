import { Profile, User } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';

// Get user profile from DB
const getUserFromDB = async (id: string) => {
  const result = await prisma.user.findUniqueOrThrow({
    where: { id },
    omit: {
      password: true,
    },
  });
  return result;
};

// Update user profile in DB
const updateUserProfileInDB = async (
  id: string,
  payload: Partial<User & Profile>,
) => {
  const { name, email, profilePhoto, bio } = payload;

  const result = await prisma.user.update({
    where: { id },
    data: {
      name,
      email,
      profile: {
        update: {
          profilePhoto,
          bio,
        },
      },
    },
    omit: {
      password: true,
    },
    include: {
      profile: true,
    },
  });

  return result;
};

export const userService = {
  getUserFromDB,
  updateUserProfileInDB,
};
