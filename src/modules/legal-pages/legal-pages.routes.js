import { LegalPagesController } from './legal-pages.controller.js'

const ctrl = new LegalPagesController()

/**
 * Public, unauthenticated — the website (and, via its in-app WebView, the
 * mobile apps) fetch legal page content here. No auth required, same as
 * banners/theme (see app.js "Anonymous public responses" comment).
 */
export default async function legalPagesRoutes(fastify) {
  fastify.get('/:slug', ctrl.getBySlug)
}
