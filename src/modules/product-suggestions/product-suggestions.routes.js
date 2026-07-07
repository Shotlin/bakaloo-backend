import { ProductSuggestionsController } from './product-suggestions.controller.js'
import { ProductSuggestionsService } from './product-suggestions.service.js'
import { ProductSuggestionsRepository } from './product-suggestions.repository.js'

/**
 * Admin Product Suggestions routes.
 * Prefix: /api/v1/admin/product-suggestions
 *
 *   GET /rules                       — all categories with their configured target categories
 *   PUT /rules/:sourceCategoryId     — replace one category's target-category list
 */
export default async function adminProductSuggestionsRoutes(fastify) {
  const repository = new ProductSuggestionsRepository()
  const service = new ProductSuggestionsService(repository)
  const controller = new ProductSuggestionsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/rules', {
    schema: { tags: ['Product Suggestions'], summary: 'Get all category suggestion rules' },
    preHandler: adminAuth,
  }, controller.getRules.bind(controller))

  fastify.put('/rules/:sourceCategoryId', {
    schema: { tags: ['Product Suggestions'], summary: 'Replace target categories for one source category' },
    preHandler: adminAuth,
  }, controller.replaceRules.bind(controller))
}
