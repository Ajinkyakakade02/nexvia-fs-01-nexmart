import fs from 'fs';
import path from 'path';
import app from './app.js';
import env from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createIndexIfNotExists } from './services/searchService.js';
import logger from './utils/logger.js';

const startServer = async () => {
  try {
    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Connect to MongoDB
    await connectDB();

    // Initialize Elasticsearch index if available
    createIndexIfNotExists().catch((err) => {
      logger.warn('[Elasticsearch] Index initialization notice:', err.message);
    });

    const server = app.listen(env.PORT, () => {
      logger.info(`====================================================`);
      logger.info(`  ${env.PLATFORM_NAME} API Server Running`);
      logger.info(`  Environment: ${env.NODE_ENV}`);
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
        await disconnectDB();
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

