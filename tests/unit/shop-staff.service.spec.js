import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ──
// The service imports invalidateStaffActiveCache from the shop-scope
// middleware. We mock it so we don't need a real Redis connection and
// can assert on its invocation.
vi.mock('../../src/middlewares/shop-scope.js', () => ({
  invalidateStaffActiveCache: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ShopStaffService } from '../../src/modules/shop-staff/shop-staff.service.js'
import {
  createShopStaffSchema,
  updateShopStaffSchema,
  VALID_PERMISSIONS,
  VALID_ROLES,
} from '../../src/modules/shop-staff/shop-staff.schema.js'
import { invalidateStaffActiveCache } from '../../src/middlewares/shop-scope.js'

// ─── Test fixtures ────────────────────────────────────────────
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const SHOP_ID_2 = '550e8400-e29b-41d4-a716-446655440001'
const TARGET_USER_ID = '11111111-1111-1111-1111-111111111111'
const REQUESTER_ID = '22222222-2222-2222-2222-222222222222'
const STAFF_ID = '99999999-9999-9999-9999-999999999999'

function makeRepoMock() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByUserAndShop: vi.fn(),
    countActiveByShop: vi.fn(),
    countActiveByUser: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  }
}

const VALID_CREATE_PAYLOAD = {
  shop_id: SHOP_ID,
  user_id: TARGET_USER_ID,
  role: 'SHOP_MANAGER',
  permissions: ['manage_orders', 'manage_inventory'],
}

const MOCK_STAFF_RECORD = {
  id: STAFF_ID,
  user_id: TARGET_USER_ID,
  shop_id: SHOP_ID,
  role: 'SHOP_MANAGER',
  permissions: ['manage_orders', 'manage_inventory'],
  is_active: true,
  invited_by: REQUESTER_ID,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// ShopStaffService.create()
// Validates Requirements 2.2, 2.3, 2.5
// Error response shape: { success: false, message, code } (Req 13.4 spirit)
// ═══════════════════════════════════════════════════════════════
describe('ShopStaffService.create() — limits and constraints', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new ShopStaffService(repo)
  })

  // ─── UNIQUE(user_id, shop_id) — Requirement 2.3 ──────────────
  it('rejects with STAFF_ALREADY_ASSIGNED when an active assignment already exists', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result).toEqual({
      success: false,
      message: 'User is already assigned to this shop',
      code: 'STAFF_ALREADY_ASSIGNED',
    })
    // No further checks should run after duplicate detection
    expect(repo.countActiveByShop).not.toHaveBeenCalled()
    expect(repo.countActiveByUser).not.toHaveBeenCalled()
    expect(repo.create).not.toHaveBeenCalled()
  })

  // ─── max 50 staff per shop — Requirement 2.5 ─────────────────
  it('rejects with STAFF_LIMIT_REACHED when the shop already has 50 active staff', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(50)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_LIMIT_REACHED')
    expect(result.message).toContain('50')
    expect(repo.countActiveByUser).not.toHaveBeenCalled()
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('rejects when staff count exceeds 50 (defensive — value > limit)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(75)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_LIMIT_REACHED')
  })

  it('admits the 50th staff (count = 49 before insert, hard limit is 50)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(49)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)
    expect(result.success).toBe(true)
    expect(repo.create).toHaveBeenCalledOnce()
  })

  // ─── max 10 shops per user — Requirement 2.2 ─────────────────
  it('rejects with STAFF_SHOP_LIMIT when user is already in 10 active shops', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(10)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_SHOP_LIMIT')
    expect(result.message).toContain('10')
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('admits the 10th shop assignment for a user (count = 9 before insert)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(9)
    repo.create.mockResolvedValueOnce({
      ...MOCK_STAFF_RECORD,
      shop_id: SHOP_ID_2,
    })

    const result = await service.create(
      { ...VALID_CREATE_PAYLOAD, shop_id: SHOP_ID_2 },
      REQUESTER_ID
    )
    expect(result.success).toBe(true)
  })

  // ─── Happy paths ─────────────────────────────────────────────
  it('persists the record with provided permissions and returns success', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result).toEqual({ success: true, data: MOCK_STAFF_RECORD })
    expect(repo.create).toHaveBeenCalledWith({
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
      role: 'SHOP_MANAGER',
      permissions: ['manage_orders', 'manage_inventory'],
      invited_by: REQUESTER_ID,
    })
  })

  it('defaults permissions to [] when caller provides none', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce({ ...MOCK_STAFF_RECORD, permissions: [] })

    await service.create(
      { shop_id: SHOP_ID, user_id: TARGET_USER_ID, role: 'SHOP_VIEWER' },
      REQUESTER_ID
    )

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: [] })
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// ShopStaffService.list() — pagination/filter passthrough
// ═══════════════════════════════════════════════════════════════
describe('ShopStaffService.list()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new ShopStaffService(repo)
  })

  it('forwards shop_id and filters to repository, echoes page/limit', async () => {
    repo.findMany.mockResolvedValueOnce({
      staff: [MOCK_STAFF_RECORD],
      total: 1,
    })

    const result = await service.list(SHOP_ID, {
      page: 2,
      limit: 50,
      role: 'SHOP_STAFF',
      is_active: 'true',
    })

    expect(repo.findMany).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      page: 2,
      limit: 50,
      role: 'SHOP_STAFF',
      is_active: 'true',
    })
    expect(result).toEqual({
      staff: [MOCK_STAFF_RECORD],
      total: 1,
      page: 2,
      limit: 50,
    })
  })

  it('returns an empty list with total=0 when no staff match', async () => {
    repo.findMany.mockResolvedValueOnce({ staff: [], total: 0 })

    const result = await service.list(SHOP_ID, { page: 1, limit: 20 })

    expect(result.staff).toEqual([])
    expect(result.total).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// ShopStaffService.getById() — shop-scope enforcement
// ═══════════════════════════════════════════════════════════════
describe('ShopStaffService.getById()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new ShopStaffService(repo)
  })

  it('passes the shop_id scope through to the repository', async () => {
    repo.findById.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.getById(STAFF_ID, SHOP_ID)

    expect(repo.findById).toHaveBeenCalledWith(STAFF_ID, SHOP_ID)
    expect(result).toEqual(MOCK_STAFF_RECORD)
  })

  it('returns null when the record does not exist for that shop', async () => {
    repo.findById.mockResolvedValueOnce(null)
    expect(await service.getById(STAFF_ID, SHOP_ID)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// ShopStaffService.update() — error response shape + cache invalidation
// Requirements 2.4 (permissions), 2.11 (cache invalidation propagation)
// ═══════════════════════════════════════════════════════════════
describe('ShopStaffService.update()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new ShopStaffService(repo)
  })

  it('returns STAFF_NOT_FOUND with consistent error shape when record missing', async () => {
    repo.update.mockResolvedValueOnce(null)

    const result = await service.update(
      STAFF_ID,
      { is_active: false },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result).toEqual({
      success: false,
      message: 'Staff record not found',
      code: 'STAFF_NOT_FOUND',
    })
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
  })

  it('returns success and triggers cache invalidation on permission update', async () => {
    const updated = {
      ...MOCK_STAFF_RECORD,
      permissions: ['view_financials'],
    }
    repo.update.mockResolvedValueOnce(updated)

    const result = await service.update(
      STAFF_ID,
      { permissions: ['view_financials'] },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result).toEqual({ success: true, data: updated })
    expect(repo.update).toHaveBeenCalledWith(
      STAFF_ID,
      SHOP_ID,
      { permissions: ['view_financials'] }
    )
    expect(invalidateStaffActiveCache).toHaveBeenCalledWith(
      TARGET_USER_ID,
      SHOP_ID
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// ShopStaffService.delete() — error response shape + scope
// ═══════════════════════════════════════════════════════════════
describe('ShopStaffService.delete()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new ShopStaffService(repo)
  })

  it('returns STAFF_NOT_FOUND with consistent error shape when record missing', async () => {
    repo.findById.mockResolvedValueOnce(null)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result).toEqual({
      success: false,
      message: 'Staff record not found',
      code: 'STAFF_NOT_FOUND',
    })
    expect(repo.softDelete).not.toHaveBeenCalled()
  })

  it('returns simple { success: true } on successful soft-delete', async () => {
    repo.findById.mockResolvedValueOnce(MOCK_STAFF_RECORD)
    repo.softDelete.mockResolvedValueOnce(true)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result).toEqual({ success: true })
    expect(repo.softDelete).toHaveBeenCalledWith(STAFF_ID, SHOP_ID)
  })
})

// ═══════════════════════════════════════════════════════════════
// shop-staff schema — Permissions JSON validation
// Validates Requirement 2.4 (permissions JSON contains only valid values)
// and Requirement 2.1 (role enum)
// ═══════════════════════════════════════════════════════════════
describe('createShopStaffSchema — permissions and role validation', () => {
  const VALID_BASE = {
    shop_id: SHOP_ID,
    user_id: TARGET_USER_ID,
    role: 'SHOP_MANAGER',
  }

  it('lists exactly the 9 permissions from Requirement 2.4', () => {
    expect(VALID_PERMISSIONS).toEqual([
      'manage_products',
      'manage_orders',
      'manage_inventory',
      'view_financials',
      'manage_financials',
      'manage_staff',
      'manage_settings',
      'manage_customers',
      'manage_riders',
    ])
  })

  it('lists exactly the 4 staff roles from Requirement 2.1', () => {
    expect(VALID_ROLES).toEqual([
      'SHOP_ADMIN',
      'SHOP_MANAGER',
      'SHOP_STAFF',
      'SHOP_VIEWER',
    ])
  })

  it('accepts a payload with no permissions and applies the [] default', () => {
    const parsed = createShopStaffSchema.safeParse(VALID_BASE)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.permissions).toEqual([])
    }
  })

  it('accepts every valid permission individually', () => {
    for (const perm of VALID_PERMISSIONS) {
      const parsed = createShopStaffSchema.safeParse({
        ...VALID_BASE,
        permissions: [perm],
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('accepts the full set of 9 valid permissions', () => {
    const parsed = createShopStaffSchema.safeParse({
      ...VALID_BASE,
      permissions: VALID_PERMISSIONS,
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    'manage_everything',
    'admin',
    '',
    'MANAGE_ORDERS', // case sensitive
    'manage products', // space instead of underscore
  ])('rejects invalid permission "%s"', (badPerm) => {
    const parsed = createShopStaffSchema.safeParse({
      ...VALID_BASE,
      permissions: [badPerm],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects when one entry in the permissions array is invalid', () => {
    const parsed = createShopStaffSchema.safeParse({
      ...VALID_BASE,
      permissions: ['manage_orders', 'unknown_permission'],
    })
    expect(parsed.success).toBe(false)
  })

  it.each(['SHOP_OWNER', 'OWNER', 'shop_admin', '', 'ADMIN'])(
    'rejects invalid role "%s"',
    (role) => {
      const parsed = createShopStaffSchema.safeParse({ ...VALID_BASE, role })
      expect(parsed.success).toBe(false)
    }
  )

  it('rejects non-UUID shop_id and user_id', () => {
    expect(
      createShopStaffSchema.safeParse({ ...VALID_BASE, shop_id: 'abc' }).success
    ).toBe(false)
    expect(
      createShopStaffSchema.safeParse({ ...VALID_BASE, user_id: '12345' })
        .success
    ).toBe(false)
  })
})

describe('updateShopStaffSchema', () => {
  it('rejects an empty body (must update at least one field)', () => {
    expect(updateShopStaffSchema.safeParse({}).success).toBe(false)
  })

  it('accepts is_active toggle alone', () => {
    expect(updateShopStaffSchema.safeParse({ is_active: false }).success).toBe(
      true
    )
  })

  it('accepts a permissions update alone', () => {
    expect(
      updateShopStaffSchema.safeParse({ permissions: ['manage_orders'] }).success
    ).toBe(true)
  })

  it('rejects an unknown permission inside permissions array', () => {
    expect(
      updateShopStaffSchema.safeParse({ permissions: ['manage_universe'] })
        .success
    ).toBe(false)
  })
})
