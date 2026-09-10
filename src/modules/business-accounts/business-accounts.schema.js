import { z } from 'zod'

// GSTIN: 15 chars, standard format (2-digit state code + 10-char PAN +
// entity code + Z + checksum). Validated loosely on format, not checksum —
// the admin reviewing the application is the real verification step.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

export const applyBusinessAccountSchema = z.object({
  companyName: z.string().trim().min(2).max(255),
  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN'),
})

export const toggleBusinessAccountSchema = z.object({
  enabled: z.boolean(),
})
