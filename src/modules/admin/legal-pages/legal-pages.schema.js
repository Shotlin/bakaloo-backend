export const legalPageSlugSchema = {
  params: {
    type: 'object',
    required: ['slug'],
    properties: { slug: { type: 'string', enum: ['terms', 'privacy', 'about'] } },
  },
}

export const updateLegalPageSchema = {
  params: {
    type: 'object',
    required: ['slug'],
    properties: { slug: { type: 'string', enum: ['terms', 'privacy', 'about'] } },
  },
  body: {
    type: 'object',
    required: ['title', 'contentHtml'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      contentHtml: { type: 'string', minLength: 1, maxLength: 200000 },
    },
  },
}
