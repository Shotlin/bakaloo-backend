import { z } from 'zod'

/**
 * GSTR-1 module — Zod validation schemas.
 *
 * Every data/export endpoint accepts EITHER a structured period
 * ({ periodType, year, month|quarter }) OR a raw { startDate, endDate }
 * range — the structured form is preferred (it's what drives the due-date
 * banner too) but raw dates are supported for ad-hoc queries.
 */

const periodTypeSchema = z.enum(['MONTH', 'QUARTER'])

export const periodQuerySchema = z
  .object({
    periodType: periodTypeSchema.optional(),
    year: z.coerce.number().int().min(2017).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    quarter: z.coerce.number().int().min(1).max(4).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(
    (v) => (v.periodType && v.year) || (v.startDate && v.endDate),
    { message: 'Provide either periodType+year(+month/quarter) or startDate+endDate' }
  )
  .refine(
    (v) => !v.periodType || v.periodType !== 'MONTH' || v.month !== undefined,
    { message: 'month is required when periodType is MONTH' }
  )
  .refine(
    (v) => !v.periodType || v.periodType !== 'QUARTER' || v.quarter !== undefined,
    { message: 'quarter is required when periodType is QUARTER' }
  )
