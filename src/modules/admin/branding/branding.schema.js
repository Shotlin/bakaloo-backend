export const updateBrandingSchema = {
  body: {
    type: 'object',
    required: ['splash_image_url', 'logo_image_url'],
    properties: {
      splash_image_url: { type: ['string', 'null'] },
      logo_image_url: { type: ['string', 'null'] },
    },
  },
}
