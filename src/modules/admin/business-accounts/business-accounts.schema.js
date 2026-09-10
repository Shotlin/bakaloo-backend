const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listBusinessAccountsSchema = {
  tags: ['Admin Business Accounts'],
  summary: 'List B2B applications with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] },
    },
  },
}

export const businessAccountDetailSchema = {
  tags: ['Admin Business Accounts'],
  summary: 'Get business account application detail',
  params: uuidParam,
}

export const approveBusinessAccountSchema = {
  tags: ['Admin Business Accounts'],
  summary: 'Approve a B2B application',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      comments: { type: 'string', maxLength: 500 },
    },
  },
}

export const rejectBusinessAccountSchema = {
  tags: ['Admin Business Accounts'],
  summary: 'Reject a B2B application',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 3, maxLength: 500 },
    },
  },
}
