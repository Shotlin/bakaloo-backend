import { success, error } from '../../utils/apiResponse.js'

export class RefundRequestsController {
  constructor(service) {
    this.service = service
  }

  async createRequest(request, reply) {
    try {
      const { orderId, itemScope, productIds, description } = request.body
      const data = await this.service.createRequest(request.user.id, {
        orderId,
        itemScope,
        productIds,
        description,
      })
      return reply.code(201).send(success(data, 'Refund request submitted'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to submit refund request'))
    }
  }

  async getMyRequests(request, reply) {
    const { page = 1, limit = 10 } = request.query
    const data = await this.service.getUserRequests(request.user.id, { page, limit })
    return reply.code(200).send(success(data, 'Refund requests fetched'))
  }

  async getByOrder(request, reply) {
    try {
      const { orderId } = request.params
      const data = await this.service.getByOrder(request.user.id, orderId)
      return reply.code(200).send(success(data, 'Refund request status fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to fetch refund request status'))
    }
  }

  async cancelRequest(request, reply) {
    try {
      const { id } = request.params
      const data = await this.service.cancelRequest(request.user.id, id)
      return reply.code(200).send(success(data, 'Refund request cancelled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to cancel refund request'))
    }
  }
}
