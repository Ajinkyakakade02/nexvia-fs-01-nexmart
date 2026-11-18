import fs from 'fs';
import path from 'path';
import app from './app.js';
import env from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { connectPrisma, disconnectPrisma, isPrismaAvailable } from './config/prisma.js';
import { createIndexIfNotExists } from './services/searchService.js';
import logger from './utils/logger.js';

const startServer = async () => {
  try {
    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // -------------------------------------------------------------------------
    // Database Connection & Provider Strategy
    // -------------------------------------------------------------------------
    logger.info(`[Database] Initializing with DB_PROVIDER='${env.DB_PROVIDER}'`);

    if (env.DB_PROVIDER === 'prisma') {
      // PostgreSQL is strictly required
      logger.info('[Database] Connecting to PostgreSQL (Prisma required)...');
      await connectPrisma(true);

      // Connect MongoDB in background for temporary transition/migration support
      connectDB().catch((err) => {
        logger.warn('[Database] Optional MongoDB transition connection notice:', err.message);
      });
    } else if (env.DB_PROVIDER === 'mongodb') {
      // MongoDB explicitly requested
      logger.info('[Database] Connecting to MongoDB (Mongoose mode)...');
      await connectDB();
    } else {
      // Auto mode: attempt PostgreSQL first; if offline, log and fallback to MongoDB
      logger.info('[Database] Auto mode: testing PostgreSQL/Prisma connection...');
      const prismaConnected = await connectPrisma(false);

      if (prismaConnected) {
        logger.info('[Database] PostgreSQL/Prisma active. Connecting transitional MongoDB...');
        connectDB().catch((err) => {
          logger.warn('[Database] Optional MongoDB transition connection notice:', err.message);
        });
      } else {
        logger.warn('[Database] PostgreSQL offline; falling back to MongoDB in auto mode');
        await connectDB();
      }
    }

    // Initialize Elasticsearch index if available
    createIndexIfNotExists().catch((err) => {
      logger.warn('[Elasticsearch] Index initialization notice:', err.message);
    });

    const activeDb = isPrismaAvailable() ? 'PostgreSQL (Prisma)' : 'MongoDB (Mongoose)';

    const server = app.listen(env.PORT, () => {
      logger.info(`====================================================`);
      logger.info(`  ${env.PLATFORM_NAME} API Server Running`);
      logger.info(`  Environment: ${env.NODE_ENV}`);
      logger.info(`  Active DB:   ${activeDb}`);
      logger.info(`  Port:        ${env.PORT}`);
      logger.info(`  API Docs:    http://localhost:${env.PORT}/api-docs`);
      logger.info(`  Health:      http://localhost:${env.PORT}/api/health`);
      logger.info(`====================================================`);
    });

    // Graceful Shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        logger.info('HTTP server closed');
        await Promise.allSettled([
          disconnectPrisma(),
          disconnectDB()
        ]);
        process.exit(0);
      });

      // Force exit if not shut down within 10s
      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
