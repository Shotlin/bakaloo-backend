import { z } from 'zod'

// Field names are snake_case throughout — matches this backend's convention
// everywhere else (fee_settings, shops.operating_hours, banners) of passing
// DB-shaped rows straight through with no camelCase mapping layer.

const timeString = z.string().regex(/^\d{1,2}:\d{2}$/, 'must be HH:MM')

const templateRow = z.object({
  weekday: z.number().int().min(0).max(6),
  is_available: z.boolean(),
  start_time: timeString,
  end_time: timeString,
  label: z.string().trim().min(1).max(60),
  display_order: z.number().int().min(0).optional(),
})

export const replaceWeeklyTemplateSchema = z.object({
  rows: z.array(templateRow).max(200),
})

const slotInput = z.object({
  start_time: timeString,
  end_time: timeString,
  label: z.string().trim().min(1).max(60),
  is_active: z.boolean().optional(),
  display_order: z.number().int().min(0).optional(),
})

export const setDayOverrideSchema = z.object({
  is_available: z.boolean(),
  note: z.string().trim().max(500).optional(),
  slots: z.array(slotInput).max(20).optional(),
})
