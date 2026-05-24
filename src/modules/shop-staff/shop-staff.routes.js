import { ShopStaffController } from './shop-staff.controller.js'
import { ShopStaffService } from './shop-staff.service.js'
import { ShopStaffRepository } from './shop-staff.repository.js'

/**
 * Shop Staff routes plugin
 * Prefix: /api/v1/shop-staff
 *
 * Authorization (current state — task 2.2):
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Platform ADMIN (super admin) is always allowed
 *   - Shop staff role checks (SHOP_ADMIN can write, SHOP_MANAGER read-only) will
 *     be fully enforced once shop-scoped JWTs land in task 2.3
 *
 * Shop scope is currently derived in the controller from:
 *   1. JWT shop_id (will exist after task 2.3)
 *   2. X-Shop-Id header (super admin)
 *   3. request body shop_id (POST only — for create)
 */
export default async function shopStaffRoutes(fastify) {
  const repository = new ShopStaffRepository()
  const service = new ShopStaffService(repository)
  const controller = new ShopStaffController(service)

  /**
   * Allow platform ADMIN or shop staff with SHOP_ADMIN role for write ops.
   * Until task 2.3 adds shop_role to JWTs, only platform ADMIN can call write routes.
   */
  const canWrite = async function requireShopAdminOrPlatformAdmin(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (shopRole === 'SHOP_ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — Shop Admin or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  /**
   * Allow platform ADMIN or shop staff with SHOP_ADMIN/SHOP_MANAGER role for reads.
   */
  const canRead = async function requireShopAdminManagerOrPlatformAdmin(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (shopRole === 'SHOP_ADMIN' || shopRole === 'SHOP_MANAGER') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — Shop Admin/Manager or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const writePreHandlers = [fastify.authenticate, canWrite]
  const readPreHandlers = [fastify.authenticate, canRead]

  // POST / — Assign staff to shop (Shop Admin / Super Admin)
  // Rate limited to prevent abuse of staff invitation endpoint
  fastify.post('/', {
    schema: {
      tags: ['Shop Staff'],
      summary: 'Assign staff to shop [Shop Admin]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: writePreHandlers,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, controller.create.bind(controller))

  // GET / — List staff (Shop Admin/Manager / Super Admin)
  fastify.get('/', {
    schema: {
      tags: ['Shop Staff'],
      summary: 'List shop staff [Shop Admin/Manager]',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          role: { type: 'string', enum: ['SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER'] },
          is_active: { type: 'string', enum: ['true', 'false'] },
          include_deleted: { type: 'string', enum: ['true', 'false'] },
        },
      },
    },
    preHandler: readPreHandlers,
  }, controller.list.bind(controller))

  // GET /:id — Get a single staff record (Shop Admin/Manager / Super Admin)
  fastify.get('/:id', {
    schema: {
      tags: ['Shop Staff'],
      summary: 'Get staff record by ID [Shop Admin/Manager]',
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
  }, controller.getOne.bind(controller))

  // PATCH /:id — Update staff role/permissions/is_active (Shop Admin / Super Admin)
  fastify.patch('/:id', {
    schema: {
      tags: ['Shop Staff'],
      summary: 'Update staff role/permissions [Shop Admin]',
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
  }, controller.update.bind(controller))

  // DELETE /:id — Soft-delete (deactivate) staff (Shop Admin / Super Admin)
  fastify.delete('/:id', {
    schema: {
      tags: ['Shop Staff'],
      summary: 'Deactivate staff member [Shop Admin]',
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
  }, controller.delete.bind(controller))
}
