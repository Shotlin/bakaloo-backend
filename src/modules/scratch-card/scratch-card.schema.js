const PRIZE_TYPES = ['FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK', 'BETTER_LUCK']
const ICON_KEYS = ['shopping_cart', 'percent', 'basket', 'coins', 'gift', 'sad_face', 'star', 'ticket']
const TRIGGER_MODES = ['ALWAYS_ON_LOGIN', 'MILESTONE_ONLY', 'MANUAL_ONLY']
const MILESTONE_TYPES = ['ORDER_COUNT', 'TOTAL_SPEND']

export const appearanceSchema = {
  tags: ['Scratch Card'],
  summary: 'Cover ("foil") image scratched away to reveal the prize',
}

export const eligibilitySchema = {
  tags: ['Scratch Card'],
  summary: 'How many scratch cards the current user has right now',
}

export const scratchSchema = {
  tags: ['Scratch Card'],
  summary: 'Resolve a scratch — decrements a scratch credit and returns the won prize',
}

export const listPrizesSchema = {
  tags: ['Scratch Card'],
  summary: 'List all scratch prizes (active + inactive templates) [ADMIN]',
}

export const createPrizeSchema = {
  tags: ['Scratch Card'],
  summary: 'Create a scratch prize [ADMIN]',
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
  tags: ['Scratch Card'],
  summary: 'Update a scratch prize [ADMIN]',
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
  tags: ['Scratch Card'],
  summary: 'Delete a scratch prize [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const reorderPrizesSchema = {
  tags: ['Scratch Card'],
  summary: 'Reorder scratch prizes [ADMIN]',
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: {
      orderedIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
    },
  },
}

export const getSettingsSchema = {
  tags: ['Scratch Card'],
  summary: 'Get scratch card settings (daily allowance, popup trigger mode, cover image) [ADMIN]',
}

export const updateSettingsSchema = {
  tags: ['Scratch Card'],
  summary: 'Update scratch card settings [ADMIN]',
  body: {
    type: 'object',
    properties: {
      dailyFreeScratches: { type: 'integer', minimum: 0 },
      triggerMode: { type: 'string', enum: TRIGGER_MODES },
      // coverImageUrl/PublicId come from the generic POST /uploads/image
      // endpoint (dashboard uploads first, then PUTs the returned url/
      // publicId here); null clears back to the app's bundled default image.
      coverImageUrl: { type: ['string', 'null'], format: 'uri' },
      coverImagePublicId: { type: ['string', 'null'] },
    },
  },
}

export const listMilestoneRulesSchema = {
  tags: ['Scratch Card'],
  summary: 'List scratch milestone rules [ADMIN]',
}

export const createMilestoneRuleSchema = {
  tags: ['Scratch Card'],
  summary: 'Create a scratch milestone rule [ADMIN]',
  body: {
    type: 'object',
    required: ['milestoneType', 'threshold'],
    properties: {
      milestoneType: { type: 'string', enum: MILESTONE_TYPES },
      threshold: { type: 'number', minimum: 0.01 },
      bonusScratches: { type: 'integer', minimum: 1, default: 1 },
      isRepeating: { type: 'boolean', default: false },
      isActive: { type: 'boolean', default: true },
    },
  },
}

export const updateMilestoneRuleSchema = {
  tags: ['Scratch Card'],
  summary: 'Update a scratch milestone rule [ADMIN]',
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
      bonusScratches: { type: 'integer', minimum: 1 },
      isRepeating: { type: 'boolean' },
      isActive: { type: 'boolean' },
    },
  },
}

export const deleteMilestoneRuleSchema = {
  tags: ['Scratch Card'],
  summary: 'Delete a scratch milestone rule [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const grantScratchesSchema = {
  tags: ['Scratch Card'],
  summary: 'Manually grant bonus scratch cards to a specific user [ADMIN]',
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
  tags: ['Scratch Card'],
  summary: 'List scratch history, optionally filtered by user [ADMIN]',
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
export const SCRATCH_CARD_ENUMS = { PRIZE_TYPES, ICON_KEYS, TRIGGER_MODES, MILESTONE_TYPES }
