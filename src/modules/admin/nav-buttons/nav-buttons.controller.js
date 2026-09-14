import { AdminNavButtonsService } from './nav-buttons.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminNavButtonsService()

export class AdminNavButtonsController {
  async list(request, reply) {
    const data = await svc.list()
    return success(data, 'Nav buttons fetched')
  }

  async getById(request, reply) {
    const btn = await svc.getById(request.params.id)
    if (!btn) return reply.code(404).send(error('Nav button not found', 'NOT_FOUND'))
    return success(btn, 'Nav button fetched')
  }

  async create(request, reply) {
    const btn = await svc.create(request.body, request.user.id, request.ip)
    return success(btn, 'Nav button created')
  }

  async update(request, reply) {
    const btn = await svc.update(request.params.id, request.body, request.user.id, request.ip)
    if (!btn) return reply.code(404).send(error('Nav button not found', 'NOT_FOUND'))
    return success(btn, 'Nav button updated')
  }

  async remove(request, reply) {
    const ok = await svc.remove(request.params.id, request.user.id, request.ip)
    if (!ok) return reply.code(404).send(error('Nav button not found', 'NOT_FOUND'))
    return success(null, 'Nav button deleted')
  }

  async reorder(request, reply) {
    await svc.reorder(request.body.orderedIds, request.user.id, request.ip)
    return success(null, 'Nav buttons reordered')
  }
}
