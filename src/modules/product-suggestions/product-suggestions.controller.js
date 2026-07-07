import { success, error } from '../../utils/apiResponse.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import { replaceRulesSchema } from './product-suggestions.schema.js'

export class ProductSuggestionsController {
  constructor(service) {
    this.service = service
  }

  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  // GET /api/v1/admin/product-suggestions/rules
  async getRules(request, reply) {
    const rules = await this.service.getRules()
    return reply.code(200).send(success({ rules }, 'Product suggestion rules fetched'))
  }

  // PUT /api/v1/admin/product-suggestions/rules/:sourceCategoryId
  async replaceRules(request, reply) {
    const { sourceCategoryId } = request.params
    const parsed = replaceRulesSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.replaceRules(sourceCategoryId, parsed.data.targetCategoryIds)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'PRODUCT_SUGGESTIONS_INVALID'))
    }

    logAdminActivity(
      request.user?.id,
      `Product suggestion rules updated for category ${sourceCategoryId}`,
      'category_suggestion_rules',
      sourceCategoryId,
      null,
      { targetCategoryIds: result.data },
      request.ip
    )
    return reply.code(200).send(success({ targetCategoryIds: result.data }, 'Product suggestion rules updated'))
  }
}
