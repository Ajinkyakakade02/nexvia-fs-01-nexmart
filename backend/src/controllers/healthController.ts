import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { prismaHealthCheck } from '../config/prisma.js';
import { redisHealthCheck } from '../config/redis.js';
import { esHealthCheck } from '../config/elasticsearch.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import env from '../config/env.js';

export const getHealth = asyncHandler(async (_req: Request, res: Response) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const mongoHealthy = mongoStatus === 'connected';
  const pgHealthy = await prismaHealthCheck();
  const redisHealthy = await redisHealthCheck();
  const esHealthy = await esHealthCheck();

  const services = {
    postgresql: {
      status: pgHealthy ? 'connected' : 'disconnected',
      healthy: pgHealthy,
      provider: 'prisma'
    },
    mongodb: {
      status: mongoStatus,
      healthy: mongoHealthy,
      provider: 'mongoose'
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

  // Determine health based on configured provider policy
  let isOverallHealthy = false;
  if (env.DB_PROVIDER === 'prisma') {
    isOverallHealthy = pgHealthy;
  } else if (env.DB_PROVIDER === 'mongodb') {
    isOverallHealthy = mongoHealthy;
  } else {
    // Auto: healthy if either database is active
    isOverallHealthy = pgHealthy || mongoHealthy;
  }

  const activeDatabase = pgHealthy ? 'postgresql' : (mongoHealthy ? 'mongodb' : 'none');

  return res.status(isOverallHealthy ? StatusCodes.OK : StatusCodes.SERVICE_UNAVAILABLE).json({
    status: isOverallHealthy ? 'healthy' : 'degraded',
    platform: env.PLATFORM_NAME,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dbProviderPolicy: env.DB_PROVIDER,
    activeDatabase,
    services
  });
});
