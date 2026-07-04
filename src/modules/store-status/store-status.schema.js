import { z } from 'zod'

const dayHours = z.object({
  open: z.string().regex(/^\d{1,2}:\d{2}$/, 'open must be HH:MM'),
  close: z.string().regex(/^\d{1,2}:\d{2}$/, 'close must be HH:MM'),
  closed: z.boolean(),
})

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export const setOverrideSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).nullable(),
  note: z.string().trim().max(500).optional(),
})

export const updateWeeklyHoursSchema = z.object({
  weeklyHours: z
    .object(Object.fromEntries(WEEKDAYS.map((day) => [day, dayHours])))
    .partial(),
})

export const updateClosedBannerImageSchema = z.object({
  imageUrl: z.string().trim().url().nullable(),
})
