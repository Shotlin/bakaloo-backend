import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendEachMock = vi.fn()

vi.mock('../../../src/config/env.js', () => ({
  env: {
    FCM_ENABLED: true,
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_PRIVATE_KEY: 'key',
    FIREBASE_CLIENT_EMAIL: 'test@test.com',
  },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('firebase-admin', () => ({
  default: {
    apps: [],
    credential: { cert: vi.fn() },
    initializeApp: vi.fn(() => ({})),
    messaging: () => ({ sendEach: sendEachMock }),
  },
}))

const { sendPushBatch } = await import('../../../src/utils/pushNotification.js')

describe('sendPushBatch chunking', () => {
  beforeEach(() => {
    sendEachMock.mockReset()
  })

  it('splits more than 500 tokens into multiple sendEach calls of <=500 each', async () => {
    const tokens = Array.from({ length: 1200 }, (_, i) => `tok-${i}`)

    sendEachMock.mockImplementation(async (messages) => ({
      successCount: messages.length,
      failureCount: 0,
      responses: messages.map(() => ({ success: true })),
    }))

    const result = await sendPushBatch(tokens, { title: 'Hi', body: 'Body' })

    expect(sendEachMock).toHaveBeenCalledTimes(3) // 500 + 500 + 200
    for (const call of sendEachMock.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(500)
    }
    expect(result.success).toBe(true)
    expect(result.sent).toBe(1200)
    expect(result.failed).toBe(0)
  })

  it('does not throw the FCM 500-item limit error and reports partial success if one chunk errors', async () => {
    const tokens = Array.from({ length: 600 }, (_, i) => `tok-${i}`)
    let call = 0
    sendEachMock.mockImplementation(async (messages) => {
      call += 1
      if (call === 2) {
        throw new Error('messages list must not contain more than 500 items')
      }
      return {
        successCount: messages.length,
        failureCount: 0,
        responses: messages.map(() => ({ success: true })),
      }
    })

    const result = await sendPushBatch(tokens, { title: 'Hi', body: 'Body' })

    expect(result.success).toBe(true) // first chunk succeeded
    expect(result.sent).toBe(500)
    expect(result.failed).toBe(100)
  })

  it('collects invalid tokens across chunks', async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `tok-${i}`)
    sendEachMock.mockImplementation(async (messages) => ({
      successCount: messages.length - 1,
      failureCount: 1,
      responses: messages.map((_, idx) =>
        idx === 0
          ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
          : { success: true }
      ),
    }))

    const result = await sendPushBatch(tokens, { title: 'Hi', body: 'Body' })

    expect(result.invalidTokens).toEqual(['tok-0', 'tok-500'])
  })
})
