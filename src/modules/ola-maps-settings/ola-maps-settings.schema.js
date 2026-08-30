/**
 * Ola Maps admin settings JSON Schemas
 */

export const getSettingsSchema = {
  tags: ['Admin - Maps'],
  summary: 'Get Ola Maps integration settings',
  security: [{ bearerAuth: [] }],
}

export const testSettingsSchema = {
  tags: ['Admin - Maps'],
  summary: 'Test an Ola Maps API key before saving (not persisted)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['apiKey'],
    properties: {
      apiKey: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
}

export const updateSettingsSchema = {
  tags: ['Admin - Maps'],
  summary: 'Save Ola Maps integration settings',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    properties: {
      // Omit entirely to leave the stored key untouched; empty string clears it.
      apiKey: { type: 'string', maxLength: 500 },
      isEnabled: { type: 'boolean' },
    },
  },
}
