import { success, error } from '../../utils/apiResponse.js'

/**
 * Categories controller — thin HTTP layer
 */
export class CategoriesController {
  constructor(service) {
    this.service = service
  }

  /** GET / */
  async list(request, reply) {
    const categories = await this.service.listAll()
    return reply.code(200).send(success(categories, 'Categories fetched'))
  }

  /** GET /:id */
  async getOne(request, reply) {
    const category = await this.service.getById(request.params.id)
    if (!category) {
      return reply.code(404).send(error('Category not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(category, 'Category fetched'))
  }

  /** GET /:id/products */
  async getProducts(request, reply) {
    const user = request?.user
    const customerContext =
      user && user.id && (!user.role || user.role === 'CUSTOMER')
        ? { userId: user.id }
        : null
    const result = await this.service.getProducts(
      request.params.id,
      request.query,
      customerContext
    )
    if (!result) {
      return reply.code(404).send(error('Category not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.data, 'Products fetched', { pagination: result.pagination }))
  }

  /** POST / */
  async create(request, reply) {
    const result = await this.service.create(request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'DUPLICATE'))
    }
    return reply.code(201).send(success(result.category, 'Category created'))
  }

  /** PUT /:id */
  async update(request, reply) {
    const result = await this.service.update(request.params.id, request.body)
    if (!result.success) {
      return reply.code(result.message === 'Category not found' ? 404 : 400)
        .send(error(result.message, result.message === 'Category not found' ? 'NOT_FOUND' : 'DUPLICATE'))
    }
    return reply.code(200).send(success(result.category, 'Category updated'))
  }

  /** DELETE /:id */
  async delete(request, reply) {
    const result = await this.service.delete(request.params.id)
    if (!result.success) {
      const notFound = result.message === 'Category not found'
      return reply.code(notFound ? 404 : 400)
        .send(error(result.message, notFound ? 'NOT_FOUND' : 'HAS_CHILDREN'))
    }
    return reply.code(200).send(success(null, 'Category deleted'))
  }

  /** GET /bundles [ADMIN] */
  async listBundles(request, reply) {
    const bundles = await this.service.listBundles(request.query?.productId || null)
    return reply.code(200).send(success(bundles, 'Bundles fetched'))
  }

  /** PUT /:id/membership [ADMIN] */
  async toggleBundleMembership(request, reply) {
    const { productId, isMember } = request.body
    const result = await this.service.toggleBundleMembership(request.params.id, productId, isMember)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Bundle membership updated'))
  }

  /** GET /:id/products/ranks [ADMIN] */
  async getProductRanks(request, reply) {
    const result = await this.service.getCategoryProductRanks(request.params.id)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.products, 'Category product ranking fetched'))
  }

  /** PUT /:id/products [ADMIN] */
  async setProducts(request, reply) {
    const result = await this.service.setCategoryProducts(request.params.id, request.body.productIds)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.products, 'Category products updated'))
  }
}
