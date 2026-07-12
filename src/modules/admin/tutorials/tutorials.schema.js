const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const tutorialIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const createTutorialSchema = {
  body: {
    type: 'object',
    required: ['title', 'videoUrl'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      videoUrl: { type: 'string', minLength: 1, maxLength: 500 },
      language: { type: 'string', maxLength: 50 },
      isActive: { type: 'boolean', default: true },
    },
  },
}

export const updateTutorialSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      videoUrl: { type: 'string', minLength: 1, maxLength: 500 },
      language: { type: ['string', 'null'], maxLength: 50 },
      isActive: { type: 'boolean' },
    },
  },
}

export const reorderTutorialsSchema = {
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
