import { AdminTutorialsService } from '../admin/tutorials/tutorials.service.js'
import { success } from '../../utils/apiResponse.js'

const svc = new AdminTutorialsService()

export default async function tutorialRoutes(fastify) {
  fastify.get('/', async (request, reply) => {
    const tutorials = await svc.getActive()
    return success(tutorials, 'Tutorials fetched')
  })
}
