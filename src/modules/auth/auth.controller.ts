import httpStatus from 'http-status';

import { authService } from '@/modules/auth/auth.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Login user
const loginUser = catchAsync(async (req, res) => {
  const result = await authService.loginUser(req.body);

  const { refreshToken, accessToken } = result;

  res.cookie('refreshToken', refreshToken, {
    secure: false,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  });

  res.cookie('accessToken', accessToken, {
    secure: false,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60, // 1 hour
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'User logged in successfully',
    data: {
      accessToken,
      refreshToken,
    },
  });
});

// Refresh token
const refreshToken = catchAsync(async (req, res) => {
  const { refreshToken } = req.cookies;
  const result = await authService.refreshToken(refreshToken);

  // Set rotated refresh token cookie
  res.cookie('refreshToken', result.refreshToken, {
    secure: false,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  });

  res.cookie('accessToken', result.accessToken, {
    secure: false,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60, // 1 hour
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Token refreshed successfully',
    data: result,
  });
});

// Logout
const logout = catchAsync(async (req, res) => {
  const { refreshToken } = req.cookies;

  if (refreshToken) {
    await authService.logout(refreshToken);
  }

  res.clearCookie('refreshToken');
  res.clearCookie('accessToken');

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Logged out successfully',
    data: null,
  });
});

export const authController = {
  loginUser,
  refreshToken,
  logout,
};
