import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { AdminCustomersRepository } from '../customers/customers.repository.js'
import { AddressesRepository } from '../../addresses/addresses.repository.js'
import { AreaSegmentsRepository } from './area-segments.repository.js'

export class AreaSegmentsService {
  constructor(repository = new AreaSegmentsRepository()) {
    this.repo = repository
    this.customersRepo = new AdminCustomersRepository()
    this.addressesRepo = new AddressesRepository()
  }

  async list() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  async create(data, actor) {
    if (!data.name || !data.name.trim()) {
      return { success: false, message: 'Segment name is required' }
    }

    const segment = await this.repo.create({
      name: data.name.trim(),
      description: data.description ?? null,
      riderId: data.riderId ?? null,
      priority: data.priority ?? 0,
      createdBy: actor.userId,
    })

    emitAudit('area_segment_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'area_segment',
      target_id: segment.id,
      before: null,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: segment.id, actor: actor.userId }, 'Area segment created')
    return { success: true, segment }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    const segment = await this.repo.update(id, data, actor.userId)

    emitAudit('area_segment_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'area_segment',
      target_id: id,
      before: existing,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Area segment updated')
    return { success: true, segment }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    await this.repo.delete(id)

    emitAudit('area_segment_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'area_segment',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Area segment deleted')
    return { success: true }
  }

  async getAddresses(segmentId, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const { addresses, total } = await this.repo.findAddresses(segmentId, { limit, offset })
    return {
      addresses,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async addAddress(segmentId, { userId, addressId }, actor) {
    const segment = await this.repo.findById(segmentId)
    if (!segment) {
      return { success: false, message: 'Segment not found' }
    }
    if (!userId || !addressId) {
      return { success: false, message: 'userId and addressId are required' }
    }

    const result = await this.repo.addAddress(segmentId, { userId, addressId, addedBy: actor.userId })
    if (!result.success) return result

    // Surface pre-existing conflicts immediately rather than only at
    // order-assignment time — an admin adding an address that's already
    // in another active segment should see that right away.
    const conflicts = await this.repo.findSegmentsForAddress(userId, addressId)
    const otherActiveConflicts = conflicts.filter((c) => c.id !== segmentId && c.is_active)

    emitAudit('area_segment_address_added', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'area_segment',
      target_id: segmentId,
      before: null,
      after: { userId, addressId },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    return { success: true, added: result.added, conflicts: otherActiveConflicts }
  }

  async removeAddress(segmentId, addressId, actor) {
    const removed = await this.repo.removeAddress(segmentId, addressId)
    if (!removed) {
      return { success: false, message: 'Address not found in segment' }
    }

    emitAudit('area_segment_address_removed', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'area_segment',
      target_id: segmentId,
      before: { addressId },
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    return { success: true }
  }

  async getActiveOrders(segmentId) {
    return this.repo.findActiveOrders(segmentId)
  }

  /** Search customers to add to a segment — reuses the existing admin customer search. */
  async searchCandidates(q, { limit = 20 } = {}) {
    const { customers } = await this.customersRepo.findAll({ offset: 0, limit, search: q, status: undefined })
    return customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email }))
  }

  /** A specific customer's saved addresses — reuses the existing addresses repository, for the "pick exact address" step. */
  async getCustomerAddresses(userId) {
    return this.addressesRepo.findByUser(userId)
  }
}
