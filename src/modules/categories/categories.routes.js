import { CategoriesController } from './categories.controller.js'
import { CategoriesService } from './categories.service.js'
import { CategoriesRepository } from './categories.repository.js'
import {
  listCategoriesSchema,
  getCategorySchema,
  getCategoryProductsSchema,
  createCategorySchema,
  updateCategorySchema,
  deleteCategorySchema,
} from './categories.schema.js'

/**
 * Categories routes plugin
 * Prefix: /api/v1/categories
 */
export default async function categoriesRoutes(fastify) {
  const repository = new CategoriesRepository()
  const service = new CategoriesService(repository)
  const controller = new CategoriesController(service)

  // GET / — All categories (cached 30 min)
  fastify.get('/', {
    schema: listCategoriesSchema,
  }, controller.list.bind(controller))

  // GET /:id — Single category
  fastify.get('/:id', {
    schema: getCategorySchema,
  }, controller.getOne.bind(controller))

  // GET /:id/products — Products by category (paginated)
  fastify.get('/:id/products', {
    schema: getCategoryProductsSchema,
  }, controller.getProducts.bind(controller))

  // POST / — Create category [ADMIN]
  fastify.post('/', {
    schema: createCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.create.bind(controller))

  // PUT /:id — Update category [ADMIN]
  fastify.put('/:id', {
    schema: updateCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.update.bind(controller))

  // DELETE /:id — Delete category [ADMIN]
  fastify.delete('/:id', {
    schema: deleteCategorySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.delete.bind(controller))
}
