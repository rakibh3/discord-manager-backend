import httpStatus from 'http-status';

import { TUser } from '@/interface';
import { userService } from '@/modules/user/user.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Create user profile
const createUser = catchAsync(async (req, res) => {
  const result = await userService.createUserIntoDB(req.body);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.CREATED,
    message: 'User registered successfully',
    data: result,
  });
});

// Get user profile
const getUserProfile = catchAsync(async (req, res) => {
  const { id } = req.user as TUser;
  const result = await userService.getUserFromDB(id);
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'User profile retrieved successfully',
    data: result,
  });
});

// Update user profile
const updateUserProfile = catchAsync(async (req, res) => {
  const { id } = req.user as TUser;
  const result = await userService.updateUserProfileInDB(id, req.body);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'User profile updated successfully',
    data: result,
  });
});

export const userController = {
  createUser,
  getUserProfile,
  updateUserProfile,
};
