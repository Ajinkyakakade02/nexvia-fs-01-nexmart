import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { redisHealthCheck } from '../config/redis.js';
import { esHealthCheck } from '../config/elasticsearch.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import env from '../config/env.js';

export const getHealth = asyncHandler(async (_req: Request, res: Response) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const redisHealthy = await redisHealthCheck();
  const esHealthy = await esHealthCheck();

  const services = {
    mongodb: {
      status: mongoStatus,
      healthy: mongoStatus === 'connected'
    },
    redis: {
      status: redisHealthy ? 'connected' : 'unavailable (fallback to db)',
      healthy: redisHealthy
    },
    elasticsearch: {
      status: esHealthy ? 'connected' : 'unavailable',
      healthy: esHealthy
    },
    storage: {
      provider: env.STORAGE_PROVIDER,
      healthy: true
    },
    payment: {
      provider: env.PAYMENT_PROVIDER,
      testMode: true
    }
  };

  const isOverallHealthy = services.mongodb.healthy;

  return res.status(isOverallHealthy ? StatusCodes.OK : StatusCodes.SERVICE_UNAVAILABLE).json({
    status: isOverallHealthy ? 'healthy' : 'degraded',
    platform: env.PLATFORM_NAME,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services
  });
});

