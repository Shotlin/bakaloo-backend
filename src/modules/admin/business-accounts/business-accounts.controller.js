import { success, error } from '../../../utils/apiResponse.js'

export class AdminBusinessAccountsController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Business accounts fetched'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id)
      return reply.send(success(data, 'Business account details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async approve(request, reply) {
    try {
      const data = await this.service.approve(request.params.id, request.body || {}, request.user.id, request.ip)
      return reply.send(success(data, 'Business account approved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async reject(request, reply) {
    try {
      const data = await this.service.reject(request.params.id, request.body || {}, request.user.id, request.ip)
      return reply.send(success(data, 'Business account rejected'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
