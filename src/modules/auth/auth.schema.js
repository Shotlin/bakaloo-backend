/**
 * Auth module — JSON Schema definitions for Fastify route validation
 */

export const sendOtpSchema = {
  tags: ['Auth'],
  summary: 'Send OTP to mobile number',
  body: {
    type: 'object',
    required: ['phone'],
    properties: {
      phone: { type: 'string', minLength: 10, maxLength: 15 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            // In development, we return the OTP for testing
            otp: { type: 'string' },
          },
        },
      },
    },
  },
}

export const verifyOtpSchema = {
  tags: ['Auth'],
  summary: 'Verify OTP and return JWT tokens',
  body: {
    type: 'object',
    required: ['phone', 'otp'],
    properties: {
      phone: { type: 'string', minLength: 10, maxLength: 15 },
      otp: { type: 'string', minLength: 4, maxLength: 8 },
      role: { type: 'string', enum: ['CUSTOMER', 'RIDER', 'DELIVERY'] },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                phone: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                isNewUser: { type: 'boolean' },
                isVerified: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
}

export const refreshTokenSchema = {
  tags: ['Auth'],
  summary: 'Get new access token using refresh token',
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
          },
        },
      },
    },
  },
}

export const logoutSchema = {
  tags: ['Auth'],
  summary: 'Logout — invalidate refresh token',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
}

export const deleteAccountSchema = {
  tags: ['Auth'],
  summary: 'Delete user account (GDPR)',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
}
