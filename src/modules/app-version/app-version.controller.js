import { success, error } from '../../utils/apiResponse.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import { checkVersionQuerySchema, updateVersionConfigSchema } from './app-version.schema.js'

/**
 * App Version controller — thin HTTP layer over AppVersionService.
 */
export class AppVersionController {
  constructor(service) {
    this.service = service
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  // GET /api/v1/app/version-check?platform=android&buildNumber=27 — public, no auth
  async check(request, reply) {
    const parsed = checkVersionQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.check(parsed.data.platform, parsed.data.buildNumber)
    return reply.code(200).send(success(result, 'Version check complete'))
  }

  // GET /api/v1/admin/app-versions
  async listAll(request, reply) {
    const rows = await this.service.listAll()
    return reply.code(200).send(success(rows, 'App version config fetched'))
  }

  // PUT /api/v1/admin/app-versions/:platform
  async update(request, reply) {
    const platform = request.params.platform
    if (platform !== 'android' && platform !== 'ios') {
      return reply.code(400).send(error('platform must be android or ios', 'VALIDATION_ERROR'))
    }

    const parsed = updateVersionConfigSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const adminId = request.user?.id
    const updated = await this.service.update(platform, parsed.data)

    logAdminActivity(
      adminId,
      `App version config updated for ${platform}: min build ${parsed.data.minSupportedBuild}, latest ${parsed.data.latestBuild}`,
      'app_versions',
      platform,
      null,
      parsed.data,
      request.ip
    )

    return reply.code(200).send(success(updated, 'App version config updated'))
  }
}
