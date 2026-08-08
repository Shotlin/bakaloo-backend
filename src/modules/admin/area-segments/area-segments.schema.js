const segmentProperties = {
  id:            { type: 'string' },
  name:          { type: 'string' },
  description:   { type: ['string', 'null'] },
  is_active:     { type: 'boolean' },
  rider_id:      { type: ['string', 'null'] },
  rider_name:    { type: ['string', 'null'] },
  rider_phone:   { type: ['string', 'null'] },
  priority:      { type: 'integer' },
  address_count: { type: 'integer' },
  created_at:    { type: 'string' },
  updated_at:    { type: 'string' },
}

export const listSegmentsSchema = {
  tags: ['Area Segments'],
  summary: 'List all area segments [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: segmentProperties } },
      },
    },
  },
}

export const segmentIdSchema = {
  tags: ['Area Segments'],
  summary: 'Get an area segment by id [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const createSegmentSchema = {
  tags: ['Area Segments'],
  summary: 'Create an area segment [ADMIN]',
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name:        { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      riderId:     { type: 'string', format: 'uuid' },
      priority:    { type: 'integer', minimum: 0, default: 0 },
    },
  },
}

export const updateSegmentSchema = {
  tags: ['Area Segments'],
  summary: 'Update an area segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:        { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      isActive:    { type: 'boolean' },
      riderId:     { type: ['string', 'null'], format: 'uuid' },
      priority:    { type: 'integer', minimum: 0 },
    },
  },
}

export const listAddressesSchema = {
  tags: ['Area Segments'],
  summary: 'List addresses covered by a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  querystring: {
    type: 'object',
    properties: {
      page:  { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const addAddressSchema = {
  tags: ['Area Segments'],
  summary: 'Add an exact customer address to a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['userId', 'addressId'],
    properties: {
      userId:    { type: 'string', format: 'uuid' },
      addressId: { type: 'string', format: 'uuid' },
    },
  },
}

export const removeAddressSchema = {
  tags: ['Area Segments'],
  summary: 'Remove an address from a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id', 'addressId'],
    properties: {
      id:        { type: 'string', format: 'uuid' },
      addressId: { type: 'string', format: 'uuid' },
    },
  },
}

export const getActiveOrdersSchema = {
  tags: ['Area Segments'],
  summary: 'List active orders associated with a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const searchCandidatesSchema = {
  tags: ['Area Segments'],
  summary: 'Search customers to add to a segment [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      q:     { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
}

export const getCustomerAddressesSchema = {
  tags: ['Area Segments'],
  summary: "Get a customer's saved addresses, for picking the exact segment address [ADMIN]",
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'string', format: 'uuid' } },
  },
}
