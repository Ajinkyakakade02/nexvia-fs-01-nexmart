import dotenv from 'dotenv';\
import path from 'path';\
import { z } from 'zod';\
\
// Load .env from server dir first, fallback to root dir\
dotenv.config();\
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });\
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });\
\
const envSchema = z.object({\
&#x20; NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),\
&#x20; PORT: z.coerce.number().default(5000),\
&#x20; CLIENT_URL: z.string().default('[https://frontend-sooty-two-50.vercel.app](https://frontend-sooty-two-50.vercel.app)'),\
&#x20; API_BASE_URL: z.string().default('[http://localhost:5000](http://localhost:5000)'),\
&#x20; MONGODB_URI: z.string().optional().default(''),\
\
&#x20; DATABASE_URL: z\
&#x20;   .string()\
&#x20;   .default(\
&#x20;     'DATABASE_URL'\
&#x20;   ),\
&#x20; DIRECT_URL: z\
&#x20;   .string()\
&#x20;   .default(\
&#x20;     'DIRECT_URL'\
&#x20;   ),\
&#x20; DB_PROVIDER: z.string().default('prisma'),\
\
&#x20; JWT_ACCESS_SECRET: z.string().default('dev_jwt_access_secret_key_1234567890_min_32_chars_fs01'),\
&#x20; JWT_REFRESH_SECRET: z.string().default('dev_jwt_refresh_secret_key_1234567890_min_32_chars_fs01'),\
&#x20; JWT_ACCESS_EXPIRY: z.string().default('15m'),\
&#x20; JWT_REFRESH_EXPIRY: z.string().default('7d'),\
\
&#x20; REDIS_URL: z.string().default('redis\://localhost:6379'),\
\
&#x20; ELASTICSEARCH_URL: z.string().default('[http://localhost:9200](http://localhost:9200)'),\
&#x20; ELASTICSEARCH_USERNAME: z.string().optional().default(''),\
&#x20; ELASTICSEARCH_PASSWORD: z.string().optional().default(''),\
\
&#x20; AWS_REGION: z.string().default('ap-south-1'),\
&#x20; AWS_S3_BUCKET: z.string().optional().default(''),\
&#x20; AWS_ACCESS_KEY_ID: z.string().optional().default(''),\
&#x20; AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),\
&#x20; STORAGE_PROVIDER: z.enum(['s3', 'local']).default('local'),\
\
&#x20; RAZORPAY_KEY_ID: z.string().optional().default(''),\
&#x20; RAZORPAY_KEY_SECRET: z.string().optional().default(''),\
&#x20; RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),\
&#x20; PAYMENT_PROVIDER: z.enum(['razorpay', 'simulation']).default('simulation'),\
\
&#x20; PLATFORM_NAME: z.string().default('NexMart'),\
&#x20; PLATFORM_COMMISSION_PERCENT: z.coerce.number().default(10),\
&#x20; DEFAULT_CURRENCY: z.string().default('INR'),\
\
&#x20; ADMIN_EMAIL: z.string().default('[admin@nexmart.com](mailto:admin@nexmart.com)'),\
&#x20; ADMIN_PASSWORD: z.string().default('Admin@12345'),\
&#x20; ADMIN_NAME: z.string().default('Platform Admin'),\
\
&#x20; RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),\
&#x20; RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),\
&#x20; AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20)\
});\
\
const parsedEnv = envSchema.safeParse(process.env);\
\
if (!parsedEnv.success) {\
&#x20; console.error('Invalid environment variables:', parsedEnv.error.format());\
&#x20; throw new Error('Environment variable validation failed');\
}\
\
export const env = parsedEnv.data;\
export default env;



keep this code only replace the neon eky with REDIS_URL
