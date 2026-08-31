import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage for the "Failed to update branding" bug: the dashboard
// sends BrandingConfig's camelCase shape ({ splashImageUrl, logoImageUrl } —
// see bakaloo-dashboard/src/types/branding.types.ts and
// app-branding/page.tsx's handleSave), but updateBrandingSchema.body used to
// require snake_case keys and BrandingService.updateBranding read
// data.splash_image_url/data.logo_image_url — neither of which the dashboard
// ever actually sent. Every PUT failed Fastify's schema validation with a
// 400 in under 2ms (before the handler even ran), so the feature never
// worked despite GET, the dashboard UI, and the DB layer all being correct.

const updateMock = vi.fn(async (args) => ({
  id: 'branding-1',
  splash_image_url: args.splash_image_url,
  logo_image_url: args.logo_image_url,
}))
vi.mock('../../../../src/modules/admin/branding/branding.repository.js', () => ({
  BrandingRepository: vi.fn().mockImplementation(() => ({
    update: updateMock,
    find: vi.fn(async () => null),
  })),
}))
vi.mock('../../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../../src/config/redis.js', () => ({ redis: { del: vi.fn() } }))
vi.mock('../../../../src/plugins/socketio.plugin.js', () => ({ getSocketIo: () => null }))

const { BrandingService } = await import(
  '../../../../src/modules/admin/branding/branding.service.js'
)

beforeEach(() => {
  updateMock.mockClear()
})

describe('BrandingService.updateBranding — reads the dashboard\'s actual camelCase payload', () => {
  it('maps splashImageUrl/logoImageUrl (not snake_case) through to the repository', async () => {
    const service = new BrandingService()

    const result = await service.updateBranding(
      { splashImageUrl: 'https://cdn/splash.png', logoImageUrl: 'https://cdn/logo.png' },
      'admin-1',
      '127.0.0.1'
    )

    expect(updateMock).toHaveBeenCalledWith({
      splash_image_url: 'https://cdn/splash.png',
      logo_image_url: 'https://cdn/logo.png',
    })
    expect(result).toEqual({
      splashImageUrl: 'https://cdn/splash.png',
      logoImageUrl: 'https://cdn/logo.png',
    })
  })

  it('passes through explicit nulls (clearing a field back to the app default)', async () => {
    const service = new BrandingService()

    await service.updateBranding(
      { splashImageUrl: null, logoImageUrl: 'https://cdn/logo.png' },
      'admin-1',
      '127.0.0.1'
    )

    expect(updateMock).toHaveBeenCalledWith({
      splash_image_url: null,
      logo_image_url: 'https://cdn/logo.png',
    })
  })
})
