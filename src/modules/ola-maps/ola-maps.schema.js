/**
 * Ola Maps JSON Schemas — Beta/test module
 */

export const styleUrlSchema = {
  tags: ['Maps'],
  summary: 'Get the Ola Maps vector style URL (Beta/test module)',
  security: [{ bearerAuth: [] }],
}

export const styleJsonSchema = {
  tags: ['Maps'],
  summary: 'Self-contained, key-stitched Ola Maps style document (public, no app auth)',
  querystring: {
    type: 'object',
    properties: {
      style: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
}

export const geocodeSchema = {
  tags: ['Maps'],
  summary: 'Forward geocode via Ola Maps (Beta/test module)',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    required: ['address'],
    properties: {
      address: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
}

export const reverseGeocodeSchema = {
  tags: ['Maps'],
  summary: 'Reverse geocode via Ola Maps (Beta/test module)',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    required: ['lat', 'lng'],
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
    },
  },
}
