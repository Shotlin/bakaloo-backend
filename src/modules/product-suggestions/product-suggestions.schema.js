import { z } from 'zod'

const uuid = z.string().uuid()

export const replaceRulesSchema = z.object({
  targetCategoryIds: z.array(uuid).max(50),
})
