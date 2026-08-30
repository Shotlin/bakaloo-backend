const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listRefundRequestsSchema = {
  tags: ['Admin Refund Requests'],
  summary: 'List refund requests with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

export const refundRequestDetailSchema = {
  tags: ['Admin Refund Requests'],
  summary: 'Get refund request detail',
  params: uuidParam,
}

export const approveRefundRequestSchema = {
  tags: ['Admin Refund Requests'],
  summary: 'Approve a refund request (moves money — amount is always server-computed, never admin-editable)',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      refundTo: { type: 'string', enum: ['wallet', 'original'], default: 'wallet' },
    },
  },
}

export const rejectRefundRequestSchema = {
  tags: ['Admin Refund Requests'],
  summary: 'Reject a refund request',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      adminNote: { type: 'string', maxLength: 500 },
    },
  },
}
