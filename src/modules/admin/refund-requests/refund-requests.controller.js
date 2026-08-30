import { success, error } from '../../../utils/apiResponse.js'

export class AdminRefundRequestsController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Refund requests fetched'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id)
      return reply.send(success(data, 'Refund request details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async approve(request, reply) {
    try {
      const data = await this.service.approve(request.params.id, request.body || {}, request.user.id, request.ip)
      return reply.send(success(data, 'Refund request approved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async reject(request, reply) {
    try {
      const data = await this.service.reject(request.params.id, request.body || {}, request.user.id, request.ip)
      return reply.send(success(data, 'Refund request rejected'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
