import express, { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import env from './config/env.js';
import { swaggerSpec } from './config/swagger.js';
import routes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimiter.js';

const app: Express = express();

// Security HTTP headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(
  cors({
    origin: [
      env.CLIENT_URL,
      'https://frontend-sooty-two-50.vercel.app',
      'http://localhost:5173',
      'http://localhost:3000'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-razorpay-signature']
  })
);

// Logging
if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Global rate limiting
app.use(generalLimiter);

// Cookie parser
app.use(cookieParser());

// JSON parser with rawBody capture for webhook verification
app.use(
  express.json({
    limit: '10mb',
    verify: (req: any, _res: express.Response, buf: Buffer) => {
      req.rawBody = buf;
    }
  })
);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static directory for local development image uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Swagger API Documentation UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: `${env.PLATFORM_NAME} API Documentation`
}));

// Root endpoint info
app.get('/', (_req: Request, res: Response) => {
  res.json({
    platform: env.PLATFORM_NAME,
    version: '1.0.0',
    description: 'Multi-Vendor E-Commerce Marketplace API',
    docs: '/api-docs',
    health: '/api/health'
  });
});

// Mount API routes
app.use('/api', routes);

// 404 Handler
app.use(notFound);

// Centralized Error Handler
app.use(errorHandler);

export default app;

