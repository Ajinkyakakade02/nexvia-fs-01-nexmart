import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../utils/apiError.js';
import { error as sendError } from '../utils/apiResponse.js';
import logger from '../utils/logger.js';
import env from '../config/env.js';

export const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
  let message = 'Internal Server Error';
  let errors: any = undefined;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors;
  } else if (err instanceof ZodError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = 'Validation failed';
    errors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message
    }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = 'Database validation error';
    errors = Object.values(err.errors).map((e: any) => ({
      field: e.path,
      message: e.message
    }));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = `Invalid ID format for ${err.path}: ${err.value}`;
  } else if (err.code === 11000) {
    statusCode = StatusCodes.CONFLICT;
    const duplicateKey = Object.keys(err.keyValue || {})[0];
    message = duplicateKey
      ? `A record with this ${duplicateKey} already exists`
      : 'Duplicate resource key';
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = StatusCodes.UNAUTHORIZED;
    message = 'Invalid authentication token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = StatusCodes.UNAUTHORIZED;
    message = 'Authentication token expired';
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (statusCode >= 500) {
    logger.error('Unhandled Server Error:', err);
  } else {
    logger.warn(`Handled Client Error [${statusCode}]: ${message}`, errors);
  }

  sendError(
    res,
    message,
    statusCode,
    env.NODE_ENV === 'development' ? { details: errors, stack: err.stack } : errors
  );
};

export default errorHandler;
