import { Prisma } from '@generated/prisma/client';
import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import config from '@/config';
import AppError from '@/errors/AppError';
import { handleCastValidationError } from '@/errors/castError';
import { handleDuplicateValidationError } from '@/errors/duplicateError';
import { handleZodValidationError } from '@/errors/zodError';

export const globalErrorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next,
) => {
  // ── Zod Validation Error ──
  if (err instanceof ZodError) {
    const result = handleZodValidationError(err);

    return res.status(result.statusCode).json({
      success: false,
      message: result.errorMessage,
      errorDetails: result.errorDetails,
      stack: config.env === 'development' ? err.stack : undefined,
    });
  }

  // ── Custom AppError ──
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errorDetails: err,
      stack: config.env === 'development' ? err.stack : undefined,
    });
  }

  // ── Prisma Client Validation Error (wrong field types / missing fields) ──
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({
      success: false,
      message: 'You provided incorrect field type or missing fields!',
      errorDetails: err.message,
    });
  }

  // ── Prisma Known Request Errors ──
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 — Unique constraint violation (duplicate)
    if (err.code === 'P2002') {
      const result = handleDuplicateValidationError(err);

      return res.status(result.statusCode).json({
        success: false,
        message: result.message,
        errorMessage: result.errorMessage,
        errorDetails: result.errorDetails,
        stack: config.env === 'development' ? result.stack : undefined,
      });
    }

    // P2023 — Malformed ID / inconsistent column data
    if (err.code === 'P2023') {
      const result = handleCastValidationError(err);

      return res.status(result.statusCode).json({
        success: false,
        message: result.message,
        errorMessage: result.errorMessage,
        errorDetails: result.errorDetails,
        stack: config.env === 'development' ? result.stack : undefined,
      });
    }

    // P2025 — Record not found
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        message: 'Record not found',
        errorMessage:
          (err.meta?.cause as string) || 'The requested record does not exist.',
        errorDetails: err,
        stack: config.env === 'development' ? err.stack : undefined,
      });
    }

    // P2003 — Foreign key constraint failed
    if (err.code === 'P2003') {
      return res.status(400).json({
        success: false,
        message: 'Foreign key constraint failed',
        errorMessage: `Related record not found for field: ${err.meta?.field_name || 'unknown'}`,
        errorDetails: err,
        stack: config.env === 'development' ? err.stack : undefined,
      });
    }
  }

  // ── Prisma Unknown Request Error ──
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return res.status(500).json({
      success: false,
      message: 'An unexpected database error occurred.',
      errorDetails: err.message,
    });
  }

  // ── Prisma Initialization Error ──
  if (err instanceof Prisma.PrismaClientInitializationError) {
    const statusCode = err.errorCode === 'P1000' ? 401 : 503;

    return res.status(statusCode).json({
      success: false,
      message:
        err.errorCode === 'P1000'
          ? 'Database authentication failed. Please check your credentials!'
          : "Can't reach the database server.",
      errorDetails: err.message,
    });
  }

  // ── Fallback: Unhandled Errors ──
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Something went wrong!';

  return res.status(statusCode).json({
    success: false,
    message,
    errorDetails: err,
    stack: config.env === 'development' ? err.stack : undefined,
  });
};

export default globalErrorHandler;
