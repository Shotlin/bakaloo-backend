import { AdminTutorialsRepository } from './tutorials.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminTutorialsRepository()

/**
 * Pulls the 11-char YouTube video ID out of whatever URL shape an admin
 * pastes — watch?v=, youtu.be/, /shorts/, /embed/, /live/, all with or
 * without extra query params (&t=10s, &list=..., ?si=...). Stored
 * alongside the raw URL so the app can hand video_id straight to an
 * embedded player without re-parsing anything client-side.
 */
export function extractYouTubeVideoId(rawUrl) {
  const trimmed = (rawUrl || '').trim()
  if (!trimmed) return null

  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/(?:shorts|embed|live)\/)([A-Za-z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) return match[1]
  }
  return null
}

export class AdminTutorialsService {
  async list() {
    return repo.findAll()
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(data, adminId, ip) {
    const videoId = extractYouTubeVideoId(data.videoUrl)
    if (!videoId) {
      throw { statusCode: 400, message: 'Could not find a valid YouTube video ID in that link' }
    }
    const tutorial = await repo.create({
      title: data.title,
      videoUrl: data.videoUrl,
      videoId,
      language: data.language,
      isActive: data.isActive,
    })
    logAdminActivity(adminId, 'CREATE_TUTORIAL', 'tutorial_video', tutorial.id, null, null, ip)
    return tutorial
  }

  async update(id, data, adminId, ip) {
    const mapped = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.language !== undefined && { language: data.language }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    }
    if (data.videoUrl !== undefined) {
      const videoId = extractYouTubeVideoId(data.videoUrl)
      if (!videoId) {
        throw { statusCode: 400, message: 'Could not find a valid YouTube video ID in that link' }
      }
      mapped.videoUrl = data.videoUrl
      mapped.videoId = videoId
    }
    const tutorial = await repo.update(id, mapped)
    logAdminActivity(adminId, 'UPDATE_TUTORIAL', 'tutorial_video', id, null, null, ip)
    return tutorial
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id)
    if (ok) logAdminActivity(adminId, 'DELETE_TUTORIAL', 'tutorial_video', id, null, null, ip)
    return ok
  }

  async reorder(orderedIds, adminId, ip) {
    await repo.reorder(orderedIds)
    logAdminActivity(adminId, 'REORDER_TUTORIALS', 'tutorial_video', null, null, { count: orderedIds.length }, ip)
    return true
  }

  async getActive() {
    return repo.findActive()
  }
}
