export const createRefundRequestSchema = {
  tags: ['Refund Requests'],
  summary: 'Submit a refund request for a delivered order',
  body: {
    type: 'object',
    required: ['orderId', 'itemScope', 'description'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      itemScope: { type: 'string', enum: ['ALL', 'SPECIFIC'] },
      productIds: { type: 'array', items: { type: 'string' } },
      description: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },
}

export const getMyRefundRequestsSchema = {
  tags: ['Refund Requests'],
  summary: "Get the current user's refund requests",
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 10 },
    },
  },
}
