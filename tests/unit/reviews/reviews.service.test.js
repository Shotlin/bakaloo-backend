import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheDeletePattern: vi.fn(async () => undefined),
}))

const { ReviewsService } = await import('../../../src/modules/reviews/reviews.service.js')

function makeRepository(overrides = {}) {
  return {
    checkUserOrder: vi.fn(async () => true),
    getReviewByOrder: vi.fn(async () => undefined),
    createReview: vi.fn(async () => ({ id: 'review-1', product_id: 'product-1' })),
    getReviewById: vi.fn(async () => ({ id: 'review-1', user_id: 'user-1', product_id: 'product-1' })),
    updateReview: vi.fn(async () => ({ id: 'review-1' })),
    deleteReview: vi.fn(async () => undefined),
    recomputeProductRating: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('ReviewsService.createReview', () => {
  it('rejects a review for an order the user never actually received (checkUserOrder now gates on DELIVERED)', async () => {
    const repository = makeRepository({ checkUserOrder: vi.fn(async () => false) })
    const service = new ReviewsService(repository)

    await expect(
      service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 5 })
    ).rejects.toThrow('You can only review products you have ordered')
    expect(repository.createReview).not.toHaveBeenCalled()
  })

  it('recomputes the product rating after a successful create', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 4, comment: 'Good' })

    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })

  it('never recomputes when the duplicate-review guard rejects the create', async () => {
    const repository = makeRepository({ getReviewByOrder: vi.fn(async () => ({ id: 'existing' })) })
    const service = new ReviewsService(repository)

    await expect(
      service.createReview('user-1', { productId: 'product-1', orderId: 'order-1', rating: 5 })
    ).rejects.toThrow('You have already reviewed this product for this order')
    expect(repository.recomputeProductRating).not.toHaveBeenCalled()
  })
})

describe('ReviewsService.updateReview', () => {
  it('recomputes the product rating when the rating itself changes', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.updateReview('user-1', 'review-1', { rating: 2 })

    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })

  it('skips the recompute when only the comment changes', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.updateReview('user-1', 'review-1', { comment: 'Edited comment only' })

    expect(repository.recomputeProductRating).not.toHaveBeenCalled()
  })
})

describe('ReviewsService.deleteReview', () => {
  it('recomputes the product rating after deleting', async () => {
    const repository = makeRepository()
    const service = new ReviewsService(repository)

    await service.deleteReview('user-1', 'review-1')

    expect(repository.deleteReview).toHaveBeenCalledWith('review-1')
    expect(repository.recomputeProductRating).toHaveBeenCalledWith('product-1')
  })
})
