import { Profile, User } from '@generated/prisma/client';
import bcrypt from 'bcrypt';
import httpStatus from 'http-status';

import config from '@/config';
import AppError from '@/errors/AppError';
import { prisma } from '@/lib/prisma';

// Create user and profile into DB
const createUserIntoDB = async (payLoad: User & Profile) => {
  const { name, email, password, profilePhoto } = payLoad;

  const isUserExists = await prisma.user.findUnique({
    where: { email },
  });

  if (isUserExists) {
    throw new AppError(httpStatus.CONFLICT, 'User already exists');
  }

  const hasedPassword: string = await bcrypt.hash(
    password,
    Number(config.bcrypt_salt_rounds),
  );

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        password: hasedPassword,
      },
    });

    await tx.profile.create({
      data: {
        userId: user.id,
        profilePhoto,
      },
    });

    return await tx.user.findUnique({
      where: { id: user.id },
      omit: {
        password: true,
      },
    });
  });

  return result;
};

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
  createUserIntoDB,
  getUserFromDB,
  updateUserProfileInDB,
};
