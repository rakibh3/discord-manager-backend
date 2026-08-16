import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import { SignOptions } from 'jsonwebtoken';

import config from '@/config';
import AppError from '@/errors/AppError';
import { prisma } from '@/lib/prisma';
import { jwtUtils } from '@/utils/jwt';

// Login user
const loginUser = async (payLoad: { email: string; password: string }) => {
  const userData = await prisma.user.findUniqueOrThrow({
    where: {
      email: payLoad.email,
    },
  });

  // Block non-active users from logging in
  if (userData.status !== 'ACTIVE') {
    throw new AppError(
      httpStatus.FORBIDDEN,
      `Your account has been ${userData.status.toLowerCase()}. Please contact support.`,
    );
  }

  // Ensure only administrators can log in
  if (userData.role !== 'ADMIN') {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Access denied. Only administrators are permitted to log in.',
    );
  }

  const isPasswordCorrect: boolean = await bcrypt.compare(
    payLoad.password,
    userData.password,
  );

  if (!isPasswordCorrect) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid Credentials');
  }

  const jwtPayload = {
    id: userData.id,
    name: userData.name,
    email: userData.email,
    role: userData.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret as string,
    config.jwt_access_expires_in as SignOptions,
  );

  const refreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret as string,
    config.jwt_refresh_expires_in as SignOptions,
  );

  // Store refresh token in DB for secure rotation
  const refreshTokenExpiry = new Date();
  refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + 7); // 7 days

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: userData.id,
      expiresAt: refreshTokenExpiry,
    },
  });

  // Update last active timestamp
  await prisma.user.update({
    where: { id: userData.id },
    data: { lastActiveAt: new Date() },
  });

  return {
    accessToken,
    refreshToken,
  };
};

// Refresh token
const refreshToken = async (token: string) => {
  // Verify the refresh token exists in DB and hasn't expired
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token },
  });

  if (!storedToken || storedToken.expiresAt < new Date()) {
    // Clean up expired token if it exists
    if (storedToken) {
      await prisma.refreshToken.delete({ where: { id: storedToken.id } });
    }
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      'Invalid or expired refresh token',
    );
  }

  const decoded = jwtUtils.verifyToken(
    token,
    config.jwt_refresh_secret as string,
  );

  if (!decoded) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'You are not authorized');
  }

  const userData = await prisma.user.findUniqueOrThrow({
    where: {
      id: decoded?.id,
    },
  });

  // Block non-active users
  if (userData.status !== 'ACTIVE') {
    // Delete all refresh tokens for this user
    await prisma.refreshToken.deleteMany({
      where: { userId: userData.id },
    });
    throw new AppError(
      httpStatus.FORBIDDEN,
      `Your account has been ${userData.status.toLowerCase()}. Please contact support.`,
    );
  }

  const jwtPayload = {
    id: userData.id,
    name: userData.name,
    email: userData.email,
    role: userData.role,
  };

  const accessToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_access_secret as string,
    config.jwt_access_expires_in as SignOptions,
  );

  // Rotate refresh token: delete old, create new
  const newRefreshToken = jwtUtils.createToken(
    jwtPayload,
    config.jwt_refresh_secret as string,
    config.jwt_refresh_expires_in as SignOptions,
  );

  const refreshTokenExpiry = new Date();
  refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + 7);

  await prisma.$transaction([
    prisma.refreshToken.delete({ where: { id: storedToken.id } }),
    prisma.refreshToken.create({
      data: {
        token: newRefreshToken,
        userId: userData.id,
        expiresAt: refreshTokenExpiry,
      },
    }),
  ]);

  return { accessToken, refreshToken: newRefreshToken };
};

// Logout — invalidate refresh token
const logout = async (token: string) => {
  await prisma.refreshToken.deleteMany({
    where: { token },
  });
};

export const authService = {
  loginUser,
  refreshToken,
  logout,
};
