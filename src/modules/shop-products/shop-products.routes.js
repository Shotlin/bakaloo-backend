import { ShopProductsController } from './shop-products.controller.js'
import { ShopProductsService } from './shop-products.service.js'
import { ShopProductsRepository } from './shop-products.repository.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Shop Products routes plugin.
 * Prefix: /api/v1/shop-products
 *
 * Authorization model:
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Shop scope is derived by `requireShopScope` (JWT shop_id, or X-Shop-Id
 *     header for platform Super Admins) — exposes `request.shopId`.
 *   - Read endpoints additionally require ANY of: platform ADMIN, or one of
 *     SHOP_ADMIN | SHOP_MANAGER | SHOP_STAFF | SHOP_VIEWER for the shop.
 *   - Write endpoints (POST/PATCH/DELETE/stock) require platform ADMIN or one
 *     of SHOP_ADMIN | SHOP_MANAGER | SHOP_STAFF (Requirement 3.10).
 *
 * Rate limiting (per design.md Security Model):
 *   - Stock updates: 30/min — shields the FOR UPDATE path from abuse.
 *
 * Caching, transactions, and stock-out side effects live in the service.
 */
export default async function shopProductRoutes(fastify) {
  const repository = new ShopProductsRepository()
  const service = new ShopProductsService(repository)
  const controller = new ShopProductsController(service)

  // ── Role guards ──────────────────────────────────────────
  // Defence-in-depth at the routing layer; the service repeats this check.
  const canRead = async function requireShopReadAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (
      shopRole === 'SHOP_ADMIN' ||
      shopRole === 'SHOP_MANAGER' ||
      shopRole === 'SHOP_STAFF' ||
      shopRole === 'SHOP_VIEWER'
    ) {
      return
    }
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — shop staff or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const canWrite = async function requireShopWriteAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (
      shopRole === 'SHOP_ADMIN' ||
      shopRole === 'SHOP_MANAGER' ||
      shopRole === 'SHOP_STAFF'
    ) {
      return
    }
    return reply.code(403).send({
      success: false,
      message:
        'Forbidden — Shop Admin, Manager, Staff, or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const shopScope = requireShopScope({ requireShop: true })

  const readPreHandlers = [fastify.authenticate, shopScope, canRead]
  const writePreHandlers = [fastify.authenticate, shopScope, canWrite]

  // ── POST / — Create a shop product ──────────────────────
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Create a shop product [Shop Manager+]',
        security: [{ bearerAuth: [] }],
      },
      preHandler: writePreHandlers,
    },
    controller.create.bind(controller)
  )

  // ── GET / — List shop products (paginated, filterable) ──
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'List shop products [Shop Staff+]',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            is_available: { type: 'string', enum: ['true', 'false'] },
            low_stock: { type: 'string', enum: ['true', 'false'] },
            search: { type: 'string', maxLength: 200 },
            include_deleted: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.list.bind(controller)
  )

  // ── GET /:id — Get a single shop product ────────────────
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Get shop product by ID [Shop Staff+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.getOne.bind(controller)
  )

  // ── PATCH /:id — Update non-stock fields ────────────────
  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Update shop product (price/availability/etc.) [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
    },
    controller.update.bind(controller)
  )

  // ── PATCH /:id/stock — Stock update with row-level lock ─
  // Rate limited per design.md Security Model — 30/min.
  fastify.patch(
    '/:id/stock',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Update stock_quantity (FOR UPDATE row lock) [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    controller.updateStock.bind(controller)
  )

  // ── DELETE /:id — Soft delete ───────────────────────────
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Soft-delete shop product [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
    },
    controller.delete.bind(controller)
  )
}
