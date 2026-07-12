import { success } from '../../utils/apiResponse.js'

/**
 * Reviews controller — handles product reviews
 */
export class ReviewsController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET /products/:productId — Get reviews for a product
   */
  async getProductReviews(request, reply) {
    const { productId } = request.params
    const { page = 1, limit = 10 } = request.query
    const reviews = await this.service.getProductReviews(productId, { page, limit })
    return reply.code(200).send(success(reviews, 'Reviews fetched successfully'))
  }

  /**
   * GET /eligibility/:productId — Check whether current user can review a product
   */
  async checkReviewEligibility(request, reply) {
    const { productId } = request.params
    const eligibility = await this.service.checkReviewEligibility(request.user.id, productId)
    return reply.code(200).send(success(eligibility, 'Review eligibility fetched successfully'))
  }

  /**
   * GET /order/:orderId — Get the current user's existing reviews for one order
   */
  async getReviewsByOrder(request, reply) {
    const { orderId } = request.params
    const reviews = await this.service.getReviewsByOrder(request.user.id, orderId)
    return reply.code(200).send(success(reviews, 'Order reviews fetched successfully'))
  }

  /**
   * POST / — Create a review
   */
  async createReview(request, reply) {
    const { productId, orderId, rating, comment } = request.body
    const review = await this.service.createReview(request.user.id, {
      productId,
      orderId,
      rating,
      comment,
    })
    return reply.code(201).send(success(review, 'Review created successfully'))
  }

  /**
   * PATCH /:id — Update a review
   */
  async updateReview(request, reply) {
    const { id } = request.params
    const { rating, comment } = request.body
    const review = await this.service.updateReview(request.user.id, id, { rating, comment })
    return reply.code(200).send(success(review, 'Review updated successfully'))
  }

  /**
   * DELETE /:id — Delete a review
   */
  async deleteReview(request, reply) {
    const { id } = request.params
    await this.service.deleteReview(request.user.id, id)
    return reply.code(200).send(success(null, 'Review deleted successfully'))
  }

  /**
   * GET /my-reviews — Get user's reviews
   */
  async getMyReviews(request, reply) {
    const { page = 1, limit = 10 } = request.query
    const reviews = await this.service.getUserReviews(request.user.id, { page, limit })
    return reply.code(200).send(success(reviews, 'Your reviews fetched successfully'))
  }
}
