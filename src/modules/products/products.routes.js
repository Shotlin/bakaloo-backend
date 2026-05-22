import { ProductsController } from './products.controller.js'
import { ProductsService } from './products.service.js'
import { ProductsRepository } from './products.repository.js'
import { importProductsFromCSV } from '../../utils/csvImporter.js'
import { success, error } from '../../utils/apiResponse.js'
import {
  listProductsSchema,
  searchProductsSchema,
  featuredProductsSchema,
  getProductSchema,
  getRelatedProductsSchema,
  pairWithSchema,
  createProductSchema,
  updateProductSchema,
  updateStockSchema,
  deleteProductSchema,
} from './products.schema.js'

/**
 * Products routes plugin
 * Prefix: /api/v1/products
 */
export default async function productRoutes(fastify) {
  const repository = new ProductsRepository()
  const service = new ProductsService(repository)
  const controller = new ProductsController(service)

  // GET / — List products (filter, sort, paginate)
  fastify.get('/', {
    schema: listProductsSchema,
  }, controller.list.bind(controller))

  // GET /search — Full-text search
  fastify.get('/search', {
    schema: searchProductsSchema,
  }, controller.search.bind(controller))

  // GET /featured — Featured/bestseller products
  fastify.get('/featured', {
    schema: featuredProductsSchema,
  }, controller.featured.bind(controller))

  // GET /price-drops — Products with sale_price < price
  fastify.get('/price-drops', {
    schema: {
      tags: ['Products'],
      summary: 'Products with active price drops',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        },
      },
    },
  }, controller.getPriceDrops.bind(controller))

  // GET /last-minute — Cafe/snack products for quick-add section
  fastify.get('/last-minute', {
    schema: {
      tags: ['Products'],
      summary: 'Last-minute cravings products',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        },
      },
    },
  }, controller.getLastMinute.bind(controller))

  // GET /new-arrivals — Products sorted by newest (last 30 days)
  fastify.get('/new-arrivals', async (request, reply) => {
    const { page = 1, limit = 20 } = request.query
    const result = await service.list({ page: +page, limit: +limit, sort: 'newest' })
    return reply.code(200).send(success(result.data, 'New arrivals fetched', { pagination: result.pagination }))
  })

  // GET /deals — Products with active sale_price (discounted items)
  fastify.get('/deals', async (request, reply) => {
    const result = await service.list({ page: 1, limit: +request.query.limit || 20, sort: 'price_asc', inStock: true })
    const deals = result.data.filter(p => p.sale_price && p.sale_price < p.price)
    return reply.code(200).send(success(deals, 'Deals fetched'))
  })

  // GET /:id — Single product detail
  fastify.get('/:id', {
    schema: getProductSchema,
  }, controller.getOne.bind(controller))

  // GET /:id/related — Related products
  fastify.get('/:id/related', {
    schema: getRelatedProductsSchema,
  }, controller.getRelated.bind(controller))

  fastify.get('/:id/pair-with', {
    schema: pairWithSchema,
    preHandler: [async (request, reply) => {
      if (typeof fastify.optionalAuth === 'function') {
        await fastify.optionalAuth(request, reply)
      }
    }],
    handler: async (request, reply) => {
      const { id } = request.params
      const { limit } = request.query || { limit: 10 }
      const product = await service.getById(id)
      if (!product) {
        return reply.code(404).send({ success: false, message: 'Product not found' })
      }
      const pairWith = await service.getPairWith(id, product.category_id, limit)
      return { success: true, message: 'Pair with products', data: pairWith }
    }
  })

  // POST / — Create product [ADMIN]
  fastify.post('/', {
    schema: createProductSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.create.bind(controller))

  // PUT /:id — Update product [ADMIN]
  fastify.put('/:id', {
    schema: updateProductSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.update.bind(controller))

  // PUT /:id/stock — Update stock [ADMIN]
  fastify.put('/:id/stock', {
    schema: updateStockSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.updateStock.bind(controller))

  // DELETE /:id — Delete product [ADMIN]
  fastify.delete('/:id', {
    schema: deleteProductSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.delete.bind(controller))

  // POST /bulk-import — CSV bulk import [ADMIN]
  fastify.post('/bulk-import', {
    schema: {
      tags: ['Products'],
      summary: 'Bulk import products from CSV',
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.code(400).send(error('No file uploaded', 'BAD_REQUEST'))
    }

    const buf = await data.toBuffer()
    const result = await importProductsFromCSV(buf)
    return reply.code(200).send(success(result, 'Bulk import completed'))
  })
}
