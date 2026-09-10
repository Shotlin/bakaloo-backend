import { PublicThemeController } from './public.controller.js'

const ctrl = new PublicThemeController()

export default async function publicThemeRoutes(fastify) {
  // Best-effort JWT verification: if a token is present and valid,
  // request.auth.b2b gets populated (see auth.plugin.js) so
  // resolveEffectiveAudience() can tell a logged-in B2B customer from
  // everyone else. Never rejects — these endpoints stay public/anonymous
  // when no token is present. Same pattern as products.routes.js.
  const tryAttachUser = async (request) => {
    if (typeof fastify.optionalAuth === 'function') {
      try {
        await fastify.optionalAuth(request)
      } catch {
        /* anonymous fallback */
      }
      return
    }
    try {
      await request.jwtVerify()
    } catch {
      /* anonymous fallback */
    }
  }

  // NO required-auth hook — these stay public endpoints; tryAttachUser
  // above is best-effort and never rejects.
  fastify.get('/active', {
    schema: {
      tags: ['Theme'],
      summary: 'Get active theme for the app (public, no auth)',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              anyOf: [
                { type: 'object', additionalProperties: true },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getActiveTheme.bind(ctrl))

  fastify.get('/tabs', {
    schema: {
      tags: ['Theme'],
      summary: 'Get all active tab themes (public, no auth)',
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, ctrl.getTabThemes.bind(ctrl))

  fastify.get('/tabs/:key/home', {
    schema: {
      tags: ['Theme'],
      summary: 'Get resolved home merchandising for a tab (public, no auth)',
      params: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, ctrl.getTabHomeContent.bind(ctrl))

  fastify.get('/tabs/:tabKey/sections', {
    schema: {
      tags: ['Theme'],
      summary: 'Get section manifest for a tab (public, no auth)',
      params: {
        type: 'object',
        required: ['tabKey'],
        properties: {
          tabKey: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, ctrl.getSectionManifest.bind(ctrl))

  fastify.post('/analytics', {
    schema: {
      tags: ['Theme'],
      summary: 'Record theme analytics events (public)',
      body: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                theme_id: { type: 'string' },
                tab_key: { type: 'string' },
                event_type: { type: 'string' },
                user_id: { type: 'string' },
                session_id: { type: 'string' },
                store_key: { type: 'string' },
                section_key: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, ctrl.recordAnalytics.bind(ctrl))
}
