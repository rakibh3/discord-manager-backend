import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import jwt from 'jsonwebtoken';

import config from '@/config';
import AppError from '@/errors/AppError';
import { unauthorizedErrorResponse } from '@/errors/unauthorizeError';
import { TUser, UserRole } from '@/interface';
import { prisma } from '@/lib/prisma';
import { catchAsync } from '@/utils/catchAsync';

declare global {
  namespace Express {
    interface Request {
      user?: TUser;
    }
  }
}

const auth = (...requiredRoles: UserRole[]) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization;

    if (!token) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        unauthorizedErrorResponse.message,
      );
    }

    const decoded = jwt.verify(
      token,
      config.jwt_access_secret as string,
    ) as TUser;

    if (!decoded) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        unauthorizedErrorResponse.message,
      );
    }

    const { id, email, role } = decoded;

    const user = await prisma.user.findUniqueOrThrow({
      where: { id, email },
    });

    if (!user) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        unauthorizedErrorResponse.message,
      );
    }

    // Block non-active users
    if (user.status !== 'ACTIVE') {
      res.status(httpStatus.FORBIDDEN).json({
        success: false,
        message: 'Account is not active',
        errorMessage: `Your account has been ${user.status.toLowerCase()}. Please contact support.`,
      });
      return;
    }

    if (requiredRoles.length && !requiredRoles.includes(role as UserRole)) {
      res.status(httpStatus.UNAUTHORIZED).json(unauthorizedErrorResponse);
      return;
    }

    // Update last active timestamp
    await prisma.user.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    });

    req.user = decoded;
    next();
  });
};

export default auth;
