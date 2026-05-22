import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return value
}, z.boolean())

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),
  APP_NAME: z.string().default('GroceryApp'),
  FRONTEND_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3001,http://localhost:3002'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  COOKIE_SECRET: z.string().min(16).optional(),

  // PostgreSQL
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_MIN: z.coerce.number().default(2),
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().default(30000),
  DB_CONNECTION_TIMEOUT: z.coerce.number().default(2000),
  DB_CONNECT_RETRIES: z.coerce.number().default(20),
  DB_CONNECT_RETRY_DELAY: z.coerce.number().default(1000),
  DB_SSL: booleanFromEnv.default(false),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),
  REDIS_TTL_DEFAULT: z.coerce.number().default(600),

  // OTP
  OTP_EXPIRY_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_LOCKOUT_SECONDS: z.coerce.number().default(1800),
  OTP_LENGTH: z.coerce.number().default(6),
  ALLOW_DEMO_OTP: booleanFromEnv.default(false),
  DEMO_OTP_PHONE: z.string().optional(),
  DEMO_OTP_CODE: z.string().regex(/^\d{4,8}$/).default('123456'),
  ALLOW_ALL_PINCODES: booleanFromEnv.default(false),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_CURRENCY: z.string().default('INR'),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_PRESET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('grocery-app'),

  // Rate Limiting
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
  OTP_RATE_LIMIT_MAX: z.coerce.number().default(5),
  OTP_RATE_LIMIT_WINDOW: z.coerce.number().default(300000),

  // File Upload
  MAX_FILE_SIZE: z.coerce.number().default(5242880),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),
  ENABLE_SWAGGER: booleanFromEnv.optional(),

  // 2Factor.in SMS OTP
  TWO_FACTOR_API_KEY: z.string().optional(),
  TWO_FACTOR_TEMPLATE: z.string().default('GroceryAppOTP'),
  SMS_PROVIDER: z.enum(['2factor', 'none']).default('none'),

  // Firebase FCM
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FCM_ENABLED: booleanFromEnv.default(false),

  // Demo delivery flow
  ALLOW_DEMO_DELIVERY_ACTIONS: booleanFromEnv.default(false),

  // Delivery
  DELIVERY_RADIUS_KM: z.coerce.number().default(10),
  EXPRESS_DELIVERY_MINUTES: z.coerce.number().default(30),
  PLATFORM_FEE: z.coerce.number().default(5),
  FREE_DELIVERY_ABOVE: z.coerce.number().default(499),
  DELIVERY_FEE: z.coerce.number().default(25),

  // BullMQ
  BULL_REDIS_HOST: z.string().default('localhost'),
  BULL_REDIS_PORT: z.coerce.number().default(6379),
  BULL_REDIS_PASSWORD: z.string().optional(),
  BULL_CONCURRENCY: z.coerce.number().default(5),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = {
  ...parsed.data,
  ENABLE_SWAGGER:
    parsed.data.ENABLE_SWAGGER ?? parsed.data.NODE_ENV !== 'production',
}
