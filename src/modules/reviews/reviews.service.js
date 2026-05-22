/**
 * Reviews service — business logic for reviews
 */
export class ReviewsService {
  constructor(repository) {
    this.repository = repository
  }

  async getProductReviews(productId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getProductReviews(productId, { offset, limit })
  }

  async checkReviewEligibility(userId, productId) {
    return await this.repository.checkReviewEligibility(userId, productId)
  }

  async createReview(userId, { productId, orderId, rating, comment }) {
    // Validate rating
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5')
    }

    // Check if user has purchased this product in the order
    const hasOrder = await this.repository.checkUserOrder(userId, orderId, productId)
    if (!hasOrder) {
      throw new Error('You can only review products you have ordered')
    }

    // Check if already reviewed
    const existingReview = await this.repository.getReviewByOrder(userId, orderId, productId)
    if (existingReview) {
      throw new Error('You have already reviewed this product for this order')
    }

    return await this.repository.createReview(userId, { productId, orderId, rating, comment })
  }

  async updateReview(userId, reviewId, { rating, comment }) {
    if (rating && (rating < 1 || rating > 5)) {
      throw new Error('Rating must be between 1 and 5')
    }

    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw new Error('Review not found')
    }

    if (review.user_id !== userId) {
      throw new Error('You can only update your own reviews')
    }

    return await this.repository.updateReview(reviewId, { rating, comment })
  }

  async deleteReview(userId, reviewId) {
    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw new Error('Review not found')
    }

    if (review.user_id !== userId) {
      throw new Error('You can only delete your own reviews')
    }

    return await this.repository.deleteReview(reviewId)
  }

  async getUserReviews(userId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getUserReviews(userId, { offset, limit })
  }
}
