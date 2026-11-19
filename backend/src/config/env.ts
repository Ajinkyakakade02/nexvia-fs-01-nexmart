REDIS_URL: redisUrlSchema,

    // ELASTICSEARCH (optional integration)
    ELASTICSEARCH_URL: z.string().optional().default('http://localhost:9200'),
    ELASTICSEARCH_USERNAME: z.string().optional().default(''),
    ELASTICSEARCH_PASSWORD: z.string().optional().default(''),

    // AWS S3 / FILE STORAGE
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional().default(''),
    AWS_ACCESS_KEY_ID: z.string().optional().default(''),
    AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
    STORAGE_PROVIDER: z.enum(['s3', 'local']).default('local'),

    // PAYMENT PROVIDER
    RAZORPAY_KEY_ID: z.string().optional().default(''),
    RAZORPAY_KEY_SECRET: z.string().optional().default(''),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
    PAYMENT_PROVIDER: z.enum(['razorpay', 'simulation']).default('simulation'),

    // PLATFORM
    PLATFORM_NAME: z.string().default('NexMart'),
    PLATFORM_COMMISSION_PERCENT: z.coerce.number().min(0).max(100).default(10),
    DEFAULT_CURRENCY: z.string().default('INR'),

    // ADMIN SEED
    ADMIN_EMAIL: z.preprocess(
      blankAsUndefined,
      z.string().email().default('admin@nexmart.com'),
    ),
    // No hardcoded admin password. Set this only in a private environment
    // when running the admin seed process.
    ADMIN_PASSWORD: z.string().default(''),
    ADMIN_NAME: z.string().default('Platform Admin'),

    // RATE LIMITING
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  })
  .superRefine((data, ctx) => {
    if (data.ADMIN_PASSWORD.length > 0 && data.ADMIN_PASSWORD.length < 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_PASSWORD'],
        message: 'ADMIN_PASSWORD must contain at least 12 characters when provided.',
      });
    }

    if (data.NODE_ENV !== 'production') {
      return;
    }

    // In production, never silently fall back to localhost URLs or development
    // signing secrets. These values must be configured in the hosting provider.
    const requiredProductionVariables = [
      'DATABASE_URL',
      'DIRECT_URL',
      'REDIS_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ] as const;

    for (const variableName of requiredProductionVariables) {
      if (!process.env[variableName]?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [variableName],
          message: `${variableName} must be explicitly configured in production.`,
        });
      }
    }

    if (
      data.DATABASE_URL.includes('localhost') ||
      data.DATABASE_URL.includes('127.0.0.1') ||
      data.DIRECT_URL.includes('localhost') ||
      data.DIRECT_URL.includes('127.0.0.1')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'Production database URLs must not point to localhost.',
      });
    }

    if (data.REDIS_URL.includes('localhost') || data.REDIS_URL.includes('127.0.0.1')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'Production REDIS_URL must not point to localhost.',
      });
    }

    if (data.JWT_ACCESS_SECRET.startsWith('local-only-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Set a unique JWT_ACCESS_SECRET in production.',
      });
    }

    if (data.JWT_REFRESH_SECRET.startsWith('local-only-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'Set a unique JWT_REFRESH_SECRET in production.',
      });
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  // Zod's formatted issues identify variable names and validation messages;
  // do not print process.env or connection-string values here.
  console.error('Invalid environment variables:', parsedEnv.error.format());
  throw new Error('Environment variable validation failed');
}

export const env = parsedEnv.data;
export default env;
