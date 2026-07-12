import { AdminTutorialsService } from './tutorials.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminTutorialsService()

export class AdminTutorialsController {
  async list(request, reply) {
    const data = await svc.list()
    return success(data, 'Tutorials fetched')
  }

  async getById(request, reply) {
    const tutorial = await svc.getById(request.params.id)
    if (!tutorial) return reply.code(404).send(error('Tutorial not found'))
    return success(tutorial, 'Tutorial fetched')
  }

  async create(request, reply) {
    try {
      const tutorial = await svc.create(request.body, request.user.id, request.ip)
      return reply.code(201).send(success(tutorial, 'Tutorial created'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to create tutorial'))
    }
  }

  async update(request, reply) {
    try {
      const tutorial = await svc.update(request.params.id, request.body, request.user.id, request.ip)
      if (!tutorial) return reply.code(404).send(error('Tutorial not found'))
      return success(tutorial, 'Tutorial updated')
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to update tutorial'))
    }
  }

  async remove(request, reply) {
    const ok = await svc.remove(request.params.id, request.user.id, request.ip)
    if (!ok) return reply.code(404).send(error('Tutorial not found'))
    return success(null, 'Tutorial deleted')
  }

  async reorder(request, reply) {
    await svc.reorder(request.body.orderedIds, request.user.id, request.ip)
    return success(null, 'Tutorials reordered')
  }
}
