import { AdminNotificationsController } from './notifications.controller.js'
import {
  templateIdSchema, createTemplateSchema, updateTemplateSchema,
  sendBulkSchema, scheduleCampaignSchema, listCampaignsSchema,
  campaignIdSchema, segmentCountSchema,
} from './notifications.schema.js'

const ctrl = new AdminNotificationsController()

export default async function adminNotificationRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  /* Templates */
  fastify.get('/templates', ctrl.listTemplates)
  fastify.get('/templates/:id', { schema: templateIdSchema }, ctrl.getTemplate)
  fastify.post('/templates', { schema: createTemplateSchema }, ctrl.createTemplate)
  fastify.put('/templates/:id', { schema: updateTemplateSchema }, ctrl.updateTemplate)
  fastify.delete('/templates/:id', { schema: templateIdSchema }, ctrl.deleteTemplate)

  /* Campaigns */
  fastify.post('/send-bulk', { schema: sendBulkSchema }, ctrl.sendBulk)
  fastify.post('/schedule', { schema: scheduleCampaignSchema }, ctrl.schedule)
  fastify.get('/campaigns', { schema: listCampaignsSchema }, ctrl.listCampaigns)
  fastify.get('/campaigns/:id', { schema: campaignIdSchema }, ctrl.getCampaign)
  fastify.get('/segment-count', { schema: segmentCountSchema }, ctrl.getSegmentCount)
}
