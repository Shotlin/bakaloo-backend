const offerProperties = {
  id:                     { type: 'string' },
  name:                   { type: 'string' },
  minOrderAmount:         { type: 'number' },
  rewardType:             { type: 'string' },
  rewardValue:            { type: ['number', 'null'] },
  maxDiscount:            { type: ['number', 'null'] },
  unlockCouponId:         { type: ['string', 'null'] },
  startAt:                { type: ['string', 'null'] },
  endAt:                  { type: ['string', 'null'] },
  isActive:               { type: 'boolean' },
  autoApply:              { type: 'boolean' },
  paymentMethodScope:     { type: 'string' },
  cashbackCreditTrigger:  { type: 'string' },
  applicableCategoryIds:  { type: ['array', 'null'], items: { type: 'string' } },
  applicableProductIds:   { type: ['array', 'null'], items: { type: 'string' } },
  grantsFreeDelivery:     { type: 'boolean' },
  createdAt:              { type: 'string' },
}

const offerResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: offerProperties },
  },
}

export const eligibleOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Best-fit first-time offer for a cart total',
  querystring: {
    type: 'object',
    required: ['cartTotal'],
    properties: { cartTotal: { type: 'number', minimum: 0 } },
  },
}

export const listOffersSchema = {
  tags: ['First-Time Offers'],
  summary: 'List all first-time offers [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: offerProperties } },
      },
    },
  },
}

export const createOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Create a first-time offer [ADMIN]',
  body: {
    type: 'object',
    required: ['name', 'rewardType'],
    properties: {
      name:                  { type: 'string', minLength: 1, maxLength: 100 },
      minOrderAmount:        { type: 'number', minimum: 0, default: 0 },
      rewardType:            { type: 'string', enum: ['FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'WALLET_CASHBACK', 'COUPON_UNLOCK'] },
      rewardValue:           { type: 'number', minimum: 0 },
      maxDiscount:           { type: 'number', minimum: 0 },
      unlockCouponId:        { type: 'string', format: 'uuid' },
      startAt:               { type: 'string', format: 'date-time' },
      endAt:                 { type: 'string', format: 'date-time' },
      autoApply:             { type: 'boolean', default: true },
      paymentMethodScope:    { type: 'string', enum: ['ALL', 'ONLINE_ONLY'], default: 'ALL' },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'], default: 'ORDER_DELIVERED' },
      applicableCategoryIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: 'array', items: { type: 'string', format: 'uuid' } },
      grantsFreeDelivery:    { type: 'boolean', default: false },
    },
  },
  response: { 201: offerResponse },
}

export const updateOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Update a first-time offer [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:                  { type: 'string', minLength: 1, maxLength: 100 },
      minOrderAmount:        { type: 'number', minimum: 0 },
      rewardType:            { type: 'string', enum: ['FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'WALLET_CASHBACK', 'COUPON_UNLOCK'] },
      rewardValue:           { type: 'number', minimum: 0 },
      maxDiscount:           { type: 'number', minimum: 0 },
      unlockCouponId:        { type: 'string', format: 'uuid' },
      startAt:               { type: 'string', format: 'date-time' },
      endAt:                 { type: 'string', format: 'date-time' },
      isActive:              { type: 'boolean' },
      autoApply:             { type: 'boolean' },
      paymentMethodScope:    { type: 'string', enum: ['ALL', 'ONLINE_ONLY'] },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'] },
      applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
      grantsFreeDelivery:    { type: 'boolean' },
    },
  },
  response: { 200: offerResponse },
}

export const deleteOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Delete a first-time offer [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}
