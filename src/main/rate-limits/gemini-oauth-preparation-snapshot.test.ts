import { beforeEach, describe, expect, it, vi } from 'vitest'

const { extractCredentialsMock, readAuthJsonMock, readGeminiCredentialsMock } = vi.hoisted(() => ({
  extractCredentialsMock: vi.fn(),
  readAuthJsonMock: vi.fn(),
  readGeminiCredentialsMock: vi.fn()
}))

vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredentialsMock
}))

vi.mock('./gemini-oauth-sources', () => ({
  readAuthJson: readAuthJsonMock,
  readGeminiCredentials: readGeminiCredentialsMock
}))

import {
  getGeminiOAuthPreparationSnapshot,
  hydrateGeminiOAuthPreparationSnapshot,
  publishGeminiOAuthTokenRefresh,
  resetGeminiOAuthPreparationSnapshotForTests
} from './gemini-oauth-preparation-snapshot'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('Gemini OAuth preparation snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetGeminiOAuthPreparationSnapshotForTests()
    extractCredentialsMock.mockResolvedValue({ clientId: 'client', clientSecret: 'secret' })
    readGeminiCredentialsMock.mockResolvedValue(null)
  })

  it('coalesces concurrent hydration into one credential and discovery read', async () => {
    const read = deferred<{
      google: { type: 'oauth'; access: string; expires: number; refresh: string }
    }>()
    readAuthJsonMock.mockReturnValue(read.promise)

    const first = hydrateGeminiOAuthPreparationSnapshot(true)
    const second = hydrateGeminiOAuthPreparationSnapshot(true)
    read.resolve({ google: { type: 'oauth', access: 'token', expires: 10, refresh: 'refresh' } })

    await Promise.all([first, second])
    expect(readAuthJsonMock).toHaveBeenCalledTimes(1)
    expect(extractCredentialsMock).toHaveBeenCalledTimes(1)
    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      stale: false,
      availability: 'ready',
      value: { source: 'auth-json' }
    })
  })

  it('rejects late hydration publication after opt-out revokes ownership', async () => {
    const read = deferred<{
      google: { type: 'oauth'; access: string; expires: number; refresh: string }
    }>()
    readAuthJsonMock.mockReturnValue(read.promise)

    const hydration = hydrateGeminiOAuthPreparationSnapshot(true)
    await hydrateGeminiOAuthPreparationSnapshot(false)
    read.resolve({ google: { type: 'oauth', access: 'late', expires: 10, refresh: 'refresh' } })
    await hydration

    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      value: null,
      stale: false,
      availability: 'missing'
    })
  })

  it('does not touch OAuth sources or CLI discovery while opt-in is disabled', async () => {
    await hydrateGeminiOAuthPreparationSnapshot(false)

    expect(readAuthJsonMock).not.toHaveBeenCalled()
    expect(readGeminiCredentialsMock).not.toHaveBeenCalled()
    expect(extractCredentialsMock).not.toHaveBeenCalled()
  })

  it('publishes refreshed tokens only while the hydrated snapshot still owns the store', async () => {
    readAuthJsonMock.mockResolvedValue({
      google: { type: 'oauth', access: 'old', expires: 10, refresh: 'old-refresh|project' }
    })
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)
    const preparation = hydrated.value!

    publishGeminiOAuthTokenRefresh(preparation, {
      accessToken: 'new',
      newRefreshToken: 'new-refresh',
      expiresIn: 3600
    })
    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      auth: { access: 'new', refresh: 'new-refresh|project' }
    })

    await hydrateGeminiOAuthPreparationSnapshot(false)
    publishGeminiOAuthTokenRefresh(preparation, {
      accessToken: 'late',
      newRefreshToken: null
    })
    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      value: null,
      availability: 'missing'
    })
  })
})
