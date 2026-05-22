const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const templateIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const createTemplateSchema = {
  body: {
    type: 'object',
    required: ['name', 'title', 'body', 'type'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 2000 },
      type: { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'] },
      variables: { type: 'array', items: { type: 'string' } },
    },
  },
}

export const updateTemplateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 2000 },
      type: { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'] },
      variables: { type: 'array', items: { type: 'string' } },
    },
  },
}

export const sendBulkSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 2000 },
      segment: { type: 'string', enum: ['all', 'new', 'inactive', 'high_value'] },
      segmentFilters: { type: 'object' },
    },
  },
}

export const scheduleCampaignSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment', 'scheduledAt'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 2000 },
      segment: { type: 'string', enum: ['all', 'new', 'inactive', 'high_value'] },
      segmentFilters: { type: 'object' },
      scheduledAt: { type: 'string', format: 'date-time' },
    },
  },
}

export const listCampaignsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const campaignIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const segmentCountSchema = {
  querystring: {
    type: 'object',
    required: ['segment'],
    properties: {
      segment: { type: 'string', enum: ['all', 'new', 'inactive', 'high_value'] },
    },
  },
}
