export const adminLoginSchema = {
  tags: ['Admin Auth'],
  summary: 'Admin email + password login',
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
    },
  },
}

export const setPasswordSchema = {
  tags: ['Admin Auth'],
  summary: 'Set or change admin password',
  body: {
    type: 'object',
    required: ['password'],
    properties: {
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
}
