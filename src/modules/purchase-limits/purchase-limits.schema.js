const ruleProperties = {
  id:                 { type: 'string' },
  scope:              { type: 'string' },
  shopId:             { type: ['string', 'null'] },
  targetType:         { type: 'string' },
  categoryId:         { type: ['string', 'null'] },
  categoryName:       { type: ['string', 'null'] },
  productId:          { type: ['string', 'null'] },
  productName:        { type: ['string', 'null'] },
  label:              { type: 'string' },
  maxQtyPerOrder:     { type: ['number', 'null'] },
  windowEnabled:      { type: 'boolean' },
  windowPeriod:       { type: ['string', 'null'] },
  windowCount:        { type: ['number', 'null'] },
  maxQtyPerWindow:    { type: ['number', 'null'] },
  exemptOrderCapWithOtherItems: { type: 'boolean' },
  isActive:           { type: 'boolean' },
  createdAt:          { type: 'string' },
}

const ruleResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: ruleProperties },
  },
}

const ruleWriteBody = {
  label:              { type: 'string', minLength: 1, maxLength: 150 },
  maxQtyPerOrder:     { type: ['number', 'null'], minimum: 1 },
  windowEnabled:      { type: 'boolean' },
  windowPeriod:       { type: 'string', enum: ['DAY', 'WEEK', 'MONTH'] },
  windowCount:        { type: 'number', minimum: 1 },
  maxQtyPerWindow:    { type: 'number', minimum: 1 },
  exemptOrderCapWithOtherItems: { type: 'boolean' },
}

export const myStatusSchema = {
  tags: ['Purchase Limits'],
  summary: 'Restriction status for a set of products (customer-facing)',
  querystring: {
    type: 'object',
    required: ['productIds'],
    properties: { productIds: { type: 'string', description: 'Comma-separated product ids' } },
  },
}

export const listRulesSchema = {
  tags: ['Purchase Limits'],
  summary: 'List all purchase limit rules [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: ruleProperties } },
      },
    },
  },
}

export const createRuleSchema = {
  tags: ['Purchase Limits'],
  summary: 'Create a purchase limit rule [ADMIN]',
  body: {
    type: 'object',
    required: ['targetType', 'label'],
    properties: {
      targetType:  { type: 'string', enum: ['CATEGORY', 'PRODUCT'] },
      categoryId:  { type: 'string', format: 'uuid' },
      productId:   { type: 'string', format: 'uuid' },
      ...ruleWriteBody,
    },
  },
  response: { 201: ruleResponse },
}

export const updateRuleSchema = {
  tags: ['Purchase Limits'],
  summary: 'Update a purchase limit rule [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      isActive: { type: 'boolean' },
      ...ruleWriteBody,
    },
  },
  response: { 200: ruleResponse },
}

export const toggleRuleSchema = {
  tags: ['Purchase Limits'],
  summary: 'Toggle a purchase limit rule active/inactive [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['isActive'],
    properties: { isActive: { type: 'boolean' } },
  },
  response: { 200: ruleResponse },
}

export const deleteRuleSchema = {
  tags: ['Purchase Limits'],
  summary: 'Delete a purchase limit rule [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}
