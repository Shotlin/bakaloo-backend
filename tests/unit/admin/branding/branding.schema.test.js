import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { updateBrandingSchema } from '../../../../src/modules/admin/branding/branding.schema.js'

// Regression test for the "Failed to update branding" bug — see
// branding.service.test.js for the full story. This app's Fastify instance
// is configured with the AJV option `removeAdditional: 'all'` (src/app.js),
// which strips any body key not explicitly named in `properties` BEFORE the
// `required` check runs. The dashboard's actual payload
// ({ splashImageUrl, logoImageUrl }) against the old snake_case-only schema
// had both its keys stripped as "additional", leaving an empty object that
// then failed `required` — a 400 in under 2ms, before the handler ever ran.
function makeValidator() {
  const ajv = new Ajv({ removeAdditional: 'all', useDefaults: true, coerceTypes: 'array' })
  return ajv.compile(updateBrandingSchema.body)
}

describe('branding.schema — accepts the dashboard\'s actual camelCase payload', () => {
  it('validates { splashImageUrl, logoImageUrl } without stripping either key', () => {
    const validate = makeValidator()
    const body = {
      splashImageUrl: 'https://cdn/splash.png',
      logoImageUrl: 'https://cdn/logo.png',
    }

    const valid = validate(body)

    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)
    expect(body).toEqual({
      splashImageUrl: 'https://cdn/splash.png',
      logoImageUrl: 'https://cdn/logo.png',
    })
  })

  it('rejects the old snake_case shape (guards against regressing back to it)', () => {
    const validate = makeValidator()
    const body = {
      splash_image_url: 'https://cdn/splash.png',
      logo_image_url: 'https://cdn/logo.png',
    }

    const valid = validate(body)

    expect(valid).toBe(false)
  })
})
