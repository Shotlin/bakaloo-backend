import { success, error } from '../../utils/apiResponse.js'
import { applyBusinessAccountSchema, toggleBusinessAccountSchema } from './business-accounts.schema.js'

function formatZodErrors(zodError) {
  return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
}

function statusForCode(code) {
  switch (code) {
    case 'NOT_FOUND':
      return 404
    case 'ALREADY_APPLIED':
    case 'NOT_APPROVED':
    case 'VALIDATION_ERROR':
      return 400
    default:
      return 400
  }
}

/**
 * Business Accounts controller — customer-facing thin HTTP layer.
 * Admin approve/reject lives separately under admin/business-accounts.
 */
export class BusinessAccountsController {
  constructor(service) {
    this.service = service
  }

  /** GET /me */
  async getMine(request, reply) {
    const account = await this.service.getMine(request.user.id)
    return reply.code(200).send(success(account, 'Business account fetched'))
  }

  /** POST /apply */
  async apply(request, reply) {
    const parsed = applyBusinessAccountSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.apply(request.user.id, parsed.data)
    if (!result.success) {
      return reply.code(statusForCode(result.code)).send(error(result.message, result.code))
    }
    return reply.code(201).send(success(result.account, 'Business account application submitted'))
  }

  /** PATCH /me/toggle */
  async toggle(request, reply) {
    const parsed = toggleBusinessAccountSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.setEnabled(request.user.id, parsed.data.enabled)
    if (!result.success) {
      return reply.code(statusForCode(result.code)).send(error(result.message, result.code))
    }
    return reply.code(200).send(success(result.account, 'Business account updated'))
  }
}
