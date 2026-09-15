const PRIZE_TYPES = ['FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK', 'BETTER_LUCK']
// No BETTER_LUCK here — the first-time reward pool exists specifically to
// guarantee a real win on a user's first-ever spin, so that type is never
// legal for it (also enforced at the DB level — see migration 139).
const FIRST_TIME_PRIZE_TYPES = ['FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK']
const ICON_KEYS = ['shopping_cart', 'percent', 'basket', 'coins', 'gift', 'sad_face', 'star', 'ticket']
const TRIGGER_MODES = ['ALWAYS_ON_LOGIN', 'MILESTONE_ONLY', 'MANUAL_ONLY']
const MILESTONE_TYPES = ['ORDER_COUNT', 'TOTAL_SPEND']

export const configSchema = {
  tags: ['Spin & Win'],
  summary: 'Active prizes for rendering the wheel',
}

export const appearanceSchema = {
  tags: ['Spin & Win'],
  summary: 'Popup background image + banner-box copy for rendering the dialog',
}

export const eligibilitySchema = {
  tags: ['Spin & Win'],
  summary: 'How many spins the current user has right now',
}

export const spinSchema = {
  tags: ['Spin & Win'],
  summary: 'Resolve a spin — decrements a spin credit and returns the won prize',
}

export const listPrizesSchema = {
  tags: ['Spin & Win'],
  summary: 'List all spin prizes (active + inactive templates) [ADMIN]',
}

export const createPrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Create a spin prize [ADMIN]',
  body: {
    type: 'object',
    required: ['type', 'label'],
    properties: {
      type: { type: 'string', enum: PRIZE_TYPES },
      iconKey: { type: 'string', enum: ICON_KEYS, default: 'gift' },
      label: { type: 'string', minLength: 1, maxLength: 50 },
      value: { type: ['number', 'null'], minimum: 0 },
      winProbability: { type: 'number', minimum: 0, maximum: 100, default: 0 },
      isActive: { type: 'boolean', default: true },
      linkedCouponId: { type: ['string', 'null'], format: 'uuid' },
    },
  },
}

export const updatePrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Update a spin prize [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: PRIZE_TYPES },
      iconKey: { type: 'string', enum: ICON_KEYS },
      label: { type: 'string', minLength: 1, maxLength: 50 },
      value: { type: ['number', 'null'], minimum: 0 },
      winProbability: { type: 'number', minimum: 0, maximum: 100 },
      isActive: { type: 'boolean' },
      linkedCouponId: { type: ['string', 'null'], format: 'uuid' },
    },
  },
}

export const deletePrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Delete a spin prize [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const reorderPrizesSchema = {
  tags: ['Spin & Win'],
  summary: 'Reorder spin prizes [ADMIN]',
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: {
      orderedIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
    },
  },
}

export const listFirstTimePrizesSchema = {
  tags: ['Spin & Win'],
  summary: 'List all first-time-reward spin prizes (active + inactive templates) [ADMIN]',
}

export const createFirstTimePrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Create a first-time-reward spin prize [ADMIN]',
  body: {
    type: 'object',
    required: ['type', 'label'],
    properties: {
      type: { type: 'string', enum: FIRST_TIME_PRIZE_TYPES },
      iconKey: { type: 'string', enum: ICON_KEYS, default: 'gift' },
      label: { type: 'string', minLength: 1, maxLength: 50 },
      value: { type: ['number', 'null'], minimum: 0 },
      winProbability: { type: 'number', minimum: 0, maximum: 100, default: 0 },
      isActive: { type: 'boolean', default: true },
      linkedCouponId: { type: ['string', 'null'], format: 'uuid' },
    },
  },
}

export const updateFirstTimePrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Update a first-time-reward spin prize [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: FIRST_TIME_PRIZE_TYPES },
      iconKey: { type: 'string', enum: ICON_KEYS },
      label: { type: 'string', minLength: 1, maxLength: 50 },
      value: { type: ['number', 'null'], minimum: 0 },
      winProbability: { type: 'number', minimum: 0, maximum: 100 },
      isActive: { type: 'boolean' },
      linkedCouponId: { type: ['string', 'null'], format: 'uuid' },
    },
  },
}

export const deleteFirstTimePrizeSchema = {
  tags: ['Spin & Win'],
  summary: 'Delete a first-time-reward spin prize [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const reorderFirstTimePrizesSchema = {
  tags: ['Spin & Win'],
  summary: 'Reorder first-time-reward spin prizes [ADMIN]',
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: {
      orderedIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
    },
  },
}

export const getSettingsSchema = {
  tags: ['Spin & Win'],
  summary: 'Get spin wheel settings (daily allowance + popup trigger mode) [ADMIN]',
}

export const updateSettingsSchema = {
  tags: ['Spin & Win'],
  summary: 'Update spin wheel settings [ADMIN]',
  body: {
    type: 'object',
    properties: {
      dailyFreeSpins: { type: 'integer', minimum: 0 },
      triggerMode: { type: 'string', enum: TRIGGER_MODES },
      // Guaranteed-win first-time reward (see migration 139) — off falls
      // back to normal odds for every spin, first-ever or not.
      firstTimeRewardEnabled: { type: 'boolean' },
      // Popup appearance — background_image_url/public_id come from the
      // generic POST /uploads/image endpoint (dashboard uploads first, then
      // PUTs the returned url/publicId here); null clears back to the app's
      // bundled default image.
      backgroundImageUrl: { type: ['string', 'null'], format: 'uri' },
      backgroundImagePublicId: { type: ['string', 'null'] },
      bannerTitle: { type: 'string', minLength: 1, maxLength: 80 },
      bannerSubtitle: { type: 'string', minLength: 1, maxLength: 80 },
      bannerTagline: { type: 'string', minLength: 1, maxLength: 80 },
    },
  },
}

export const listMilestoneRulesSchema = {
  tags: ['Spin & Win'],
  summary: 'List spin milestone rules [ADMIN]',
}

export const createMilestoneRuleSchema = {
  tags: ['Spin & Win'],
  summary: 'Create a spin milestone rule [ADMIN]',
  body: {
    type: 'object',
    required: ['milestoneType', 'threshold'],
    properties: {
      milestoneType: { type: 'string', enum: MILESTONE_TYPES },
      threshold: { type: 'number', minimum: 0.01 },
      bonusSpins: { type: 'integer', minimum: 1, default: 1 },
      isRepeating: { type: 'boolean', default: false },
      isActive: { type: 'boolean', default: true },
    },
  },
}

export const updateMilestoneRuleSchema = {
  tags: ['Spin & Win'],
  summary: 'Update a spin milestone rule [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      milestoneType: { type: 'string', enum: MILESTONE_TYPES },
      threshold: { type: 'number', minimum: 0.01 },
      bonusSpins: { type: 'integer', minimum: 1 },
      isRepeating: { type: 'boolean' },
      isActive: { type: 'boolean' },
    },
  },
}

export const deleteMilestoneRuleSchema = {
  tags: ['Spin & Win'],
  summary: 'Delete a spin milestone rule [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const grantSpinsSchema = {
  tags: ['Spin & Win'],
  summary: 'Manually grant bonus spins to a specific user [ADMIN]',
  body: {
    type: 'object',
    required: ['userId', 'amount'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      amount: { type: 'integer', minimum: 1 },
    },
  },
}

export const listHistorySchema = {
  tags: ['Spin & Win'],
  summary: 'List spin history, optionally filtered by user [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 },
      userId: { type: 'string', format: 'uuid' },
    },
  },
}

// Exported for reuse if another module needs the same enums (dashboard-facing docs, etc.)
export const SPIN_WHEEL_ENUMS = { PRIZE_TYPES, FIRST_TIME_PRIZE_TYPES, ICON_KEYS, TRIGGER_MODES, MILESTONE_TYPES }
