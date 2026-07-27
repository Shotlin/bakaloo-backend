import { z } from 'zod'

export const checkVersionQuerySchema = z.object({
  platform: z.enum(['android', 'ios']),
  buildNumber: z.coerce.number().int().positive(),
})

export const updateVersionConfigSchema = z.object({
  minSupportedBuild: z.coerce.number().int().positive(),
  latestBuild: z.coerce.number().int().positive(),
  latestVersionName: z.string().trim().min(1).max(20),
  updateMessage: z.string().trim().max(500).optional().nullable(),
  storeUrl: z.string().trim().url().optional().nullable(),
})
