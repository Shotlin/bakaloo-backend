// Body keys are camelCase to match every other admin DTO in this codebase
// (and what the dashboard's BrandingConfig/UpdateBrandingPayload actually
// sends) — snake_case is a DB-column convention, not an HTTP-body one; that
// mismatch here made every PUT fail Fastify's schema validation with a 400
// before the handler ever ran, so "changing" branding never worked despite
// the dashboard UI, GET, and DB layer all being correctly wired.
export const updateBrandingSchema = {
  body: {
    type: 'object',
    required: ['splashImageUrl', 'logoImageUrl'],
    properties: {
      splashImageUrl: { type: ['string', 'null'] },
      logoImageUrl: { type: ['string', 'null'] },
    },
  },
}
