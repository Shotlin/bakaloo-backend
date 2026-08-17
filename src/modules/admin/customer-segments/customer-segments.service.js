import ExcelJS from 'exceljs'
import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { AdminCustomersRepository } from '../customers/customers.repository.js'
import { CustomerSegmentsRepository } from './customer-segments.repository.js'
import { parseSegmentImportFile } from '../../../utils/segmentMemberImporter.js'

export class CustomerSegmentsService {
  constructor(repository = new CustomerSegmentsRepository()) {
    this.repo = repository
    this.customersRepo = new AdminCustomersRepository()
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
      createdBy: actor.userId,
    })

    emitAudit('customer_segment_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segment.id,
      before: null,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: segment.id, actor: actor.userId }, 'Customer segment created')
    return { success: true, segment }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    const segment = await this.repo.update(id, data)

    emitAudit('customer_segment_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: id,
      before: existing,
      after: segment,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Customer segment updated')
    return { success: true, segment }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Segment not found' }
    }

    await this.repo.delete(id)

    emitAudit('customer_segment_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId: id, actor: actor.userId }, 'Customer segment deleted')
    return { success: true }
  }

  async getMembers(segmentId, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const { members, total } = await this.repo.findMembers(segmentId, { limit, offset })
    return {
      members,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async addMembers(segmentId, userIds, actor) {
    const segment = await this.repo.findById(segmentId)
    if (!segment) {
      return { success: false, message: 'Segment not found' }
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return { success: false, message: 'userIds must be a non-empty array' }
    }

    const addedCount = await this.repo.addMembers(segmentId, userIds, actor.userId)

    emitAudit('customer_segment_members_added', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segmentId,
      before: null,
      after: { userIds },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ segmentId, addedCount, actor: actor.userId }, 'Customer segment members added')
    return { success: true, addedCount }
  }

  async removeMember(segmentId, userId, actor) {
    const removed = await this.repo.removeMember(segmentId, userId)
    if (!removed) {
      return { success: false, message: 'Member not found in segment' }
    }

    emitAudit('customer_segment_member_removed', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segmentId,
      before: { userId },
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    return { success: true }
  }

  /** Builds the downloadable .xlsx template for bulk member import. */
  async buildImportTemplate() {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Customers')
    ws.columns = [
      { header: 'Customer Number', key: 'phone', width: 22 },
      { header: 'Customer Name', key: 'name', width: 32 },
    ]

    const headerRow = ws.getRow(1)
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF15803D' } }
    headerRow.height = 22
    headerRow.alignment = { vertical: 'middle' }
    headerRow.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F5C2E' } } }
    })

    const exampleRows = [
      ws.addRow({ phone: '9876543210', name: 'Priya Sharma — example, delete before import' }),
      ws.addRow({ phone: '9123456789', name: 'Rahul Verma — example, delete before import' }),
    ]
    exampleRows.forEach((row) => {
      row.font = { italic: true, color: { argb: 'FF6B7280' } }
    })

    ws.getCell('A1').note =
      'Only this column is used to add customers to the segment. It must be the customer\'s ' +
      '10-digit phone number — the one unique value we can always match on. The Name column ' +
      'is just for your own reference and is ignored on import.'
    ws.views = [{ state: 'frozen', ySplit: 1 }]

    const buffer = await wb.xlsx.writeBuffer()
    return { buffer, filename: 'customer-segment-import-template.xlsx' }
  }

  /**
   * Bulk-add members to a segment from an uploaded .xlsx/.csv file.
   * Matches customers by phone number only (never by name — names collide,
   * numbers don't) so a filtered export can be re-imported without editing.
   */
  async importMembers(segmentId, buffer, filename, actor) {
    const segment = await this.repo.findById(segmentId)
    if (!segment) {
      return { success: false, message: 'Segment not found' }
    }

    let parsed
    try {
      parsed = await parseSegmentImportFile(buffer, filename)
    } catch (err) {
      return { success: false, message: `Could not read that file: ${err.message}` }
    }

    if (parsed.totalRows === 0) {
      return { success: false, message: 'That file has no rows' }
    }
    if (parsed.phones.length === 0) {
      return {
        success: false,
        message:
          'No valid customer numbers found. Make sure the "Customer Number" column has 10-digit phone numbers.',
      }
    }

    const matched = await this.customersRepo.findByPhones(parsed.phones)
    const matchedIds = matched.map((m) => m.id)
    const matchedPhones = new Set(matched.map((m) => m.phone))
    const notFoundNumbers = parsed.phones.filter((p) => !matchedPhones.has(p))

    const addedCount = matchedIds.length ? await this.repo.addMembers(segmentId, matchedIds, actor.userId) : 0
    const alreadyMemberCount = matchedIds.length - addedCount

    emitAudit('customer_segment_members_imported', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'customer_segment',
      target_id: segmentId,
      before: null,
      after: {
        totalRows: parsed.totalRows,
        matchedCount: matchedIds.length,
        addedCount,
        notFoundCount: notFoundNumbers.length,
      },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info(
      { segmentId, totalRows: parsed.totalRows, addedCount, matchedCount: matchedIds.length, notFoundCount: notFoundNumbers.length, actor: actor.userId },
      'Customer segment members imported from file'
    )

    return {
      success: true,
      totalRows: parsed.totalRows,
      matchedCount: matchedIds.length,
      addedCount,
      alreadyMemberCount,
      notFoundCount: notFoundNumbers.length,
      notFoundSample: notFoundNumbers.slice(0, 25),
      unmatchedRows: parsed.unmatchedRows,
    }
  }

  /** Search customers to add to a segment — reuses the existing admin customer search. */
  async searchCandidates(q, { limit = 20 } = {}) {
    const { customers } = await this.customersRepo.findAll({
      offset: 0,
      limit,
      search: q,
      status: undefined,
    })
    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      avatar_url: c.avatar_url,
    }))
  }
}
