const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

/**
 * Every key here corresponds 1:1 to a `PhosphorIcons.<key>Fill` /
 * `PhosphorIcons.<key>` identifier already confirmed to exist in the
 * phosphoricons_flutter package this app uses — verified against the
 * package source before locking this list, not guessed. Deliberately
 * curated rather than accepting any string: this renders at nav-bar size,
 * so an admin typing a typo'd icon name should fail validation here, not
 * silently render a blank icon in production.
 */
export const NAV_BUTTON_ICON_KEYS = [
  'gift', 'gameController', 'crown', 'crownSimple', 'star', 'starFour',
  'sparkle', 'fire', 'rocket', 'rocketLaunch', 'trophy', 'medal', 'target',
  'ticket', 'confetti', 'diamond', 'shieldStar', 'moonStars',
  'house', 'basket', 'bag', 'handbag', 'storefront', 'tag', 'percent',
  'lightning', 'megaphone', 'bell', 'heart', 'shoppingBag', 'shoppingCart',
  'coin', 'wallet', 'image', 'globe', 'browser', 'deviceMobile',
]

const iconKeyBody = {
  type: 'string',
  enum: NAV_BUTTON_ICON_KEYS,
}

const commonProperties = {
  label: { type: 'string', minLength: 1, maxLength: 30 },
  iconKey: iconKeyBody,
  accentColor: { type: ['string', 'null'], pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' },
  destinationType: { type: 'string', enum: ['APP_ROUTE', 'CATEGORY', 'PRODUCT', 'WEBVIEW'] },
  destinationValue: { type: 'string', minLength: 1, maxLength: 500 },
  passIdentity: { type: 'boolean', default: false },
  audience: { type: 'string', enum: ['B2C', 'B2B', 'ALL'], default: 'ALL' },
  targetSegmentId: { type: ['string', 'null'], pattern: uuidPattern },
  isActive: { type: 'boolean', default: true },
  startDate: { type: ['string', 'null'], format: 'date-time' },
  endDate: { type: ['string', 'null'], format: 'date-time' },
}

export const navButtonIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const createNavButtonSchema = {
  body: {
    type: 'object',
    required: ['label', 'iconKey', 'destinationType', 'destinationValue'],
    properties: commonProperties,
  },
}

export const updateNavButtonSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: commonProperties,
  },
}

export const reorderNavButtonsSchema = {
  body: {
    type: 'object',
    required: ['orderedIds'],
    properties: {
      orderedIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', pattern: uuidPattern },
      },
    },
  },
}
