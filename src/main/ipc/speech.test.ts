import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  fromWebContentsMock,
  getSpeechModelManagerMock,
  getSpeechSttServiceMock,
  deleteLocalSpeechModelMock,
  saveOpenAiSpeechApiKeyMock,
  clearOpenAiSpeechApiKeyMock,
  hydrateOpenAiSpeechApiKeySnapshotMock,
  getOpenAiSpeechApiKeySnapshotMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getSpeechModelManagerMock: vi.fn(),
  getSpeechSttServiceMock: vi.fn(),
  deleteLocalSpeechModelMock: vi.fn(),
  saveOpenAiSpeechApiKeyMock: vi.fn(),
  clearOpenAiSpeechApiKeyMock: vi.fn(),
  hydrateOpenAiSpeechApiKeySnapshotMock: vi.fn(),
  getOpenAiSpeechApiKeySnapshotMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/orca-speech-test') },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  ipcMain: { handle: handleMock },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(() => Buffer.from('encrypted')),
    isEncryptionAvailable: vi.fn(() => true)
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(() => Promise.resolve(true))
  }
}))

vi.mock('../speech/model-catalog', () => ({
  SPEECH_MODEL_CATALOG: [],
  getCatalogModel: vi.fn(() => ({ id: 'model-1' }))
}))

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: getSpeechModelManagerMock,
  getSpeechSttService: getSpeechSttServiceMock
}))

vi.mock('../speech/speech-model-deletion', () => ({
  deleteLocalSpeechModel: deleteLocalSpeechModelMock
}))

vi.mock('../speech/openai-api-key-store', () => ({
  saveOpenAiSpeechApiKey: saveOpenAiSpeechApiKeyMock,
  clearOpenAiSpeechApiKey: clearOpenAiSpeechApiKeyMock,
  hydrateOpenAiSpeechApiKeySnapshot: hydrateOpenAiSpeechApiKeySnapshotMock,
  getOpenAiSpeechApiKeySnapshot: getOpenAiSpeechApiKeySnapshotMock
}))

import { registerSpeechHandlers } from './speech'

type SpeechHandler = (event: { sender: { id: number } }, value?: string) => Promise<unknown>

function getHandler(channel: string): SpeechHandler {
  const call = handleMock.mock.calls.find((entry) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1] as SpeechHandler
}

describe('registerSpeechHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    fromWebContentsMock.mockReset()
    getSpeechModelManagerMock.mockReset()
    getSpeechSttServiceMock.mockReset()
    deleteLocalSpeechModelMock.mockReset()
    saveOpenAiSpeechApiKeyMock.mockReset()
    clearOpenAiSpeechApiKeyMock.mockReset()
    hydrateOpenAiSpeechApiKeySnapshotMock.mockReset()
    getOpenAiSpeechApiKeySnapshotMock.mockReset()
    getOpenAiSpeechApiKeySnapshotMock.mockReturnValue({
      value: false,
      stale: false,
      age: 0,
      availability: 'missing'
    })
  })

  it('clears the model download progress callback after completion', async () => {
    const clearProgressCallback = vi.fn()
    const progressCallbacks: ((modelId: string, progress: number) => void)[] = []
    let resolveDownload: () => void = () => {}
    const manager = {
      setProgressCallback: vi.fn((callback: (modelId: string, progress: number) => void) => {
        progressCallbacks.push(callback)
        return clearProgressCallback
      }),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = resolve
          })
      )
    }
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send },
      once: vi.fn(),
      off: vi.fn()
    }
    getSpeechModelManagerMock.mockReturnValue(manager)
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)

    const pending = getHandler('speech:downloadModel')({ sender: { id: 7 } }, 'model-1')
    progressCallbacks[0]?.('model-1', 0.5)
    resolveDownload()
    await pending

    expect(send).toHaveBeenCalledWith('speech:downloadProgress', {
      modelId: 'model-1',
      progress: 0.5
    })
    expect(clearProgressCallback).toHaveBeenCalledTimes(1)
    expect(window.off).toHaveBeenCalledWith('closed', expect.any(Function))
  })

  it('clears the model download progress callback when the window closes', async () => {
    const clearProgressCallback = vi.fn()
    let resolveDownload: () => void = () => {}
    const closeHandlers: (() => void)[] = []
    const manager = {
      setProgressCallback: vi.fn(() => clearProgressCallback),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = resolve
          })
      )
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn((_event: string, handler: () => void) => {
        closeHandlers.push(handler)
      }),
      off: vi.fn()
    }
    getSpeechModelManagerMock.mockReturnValue(manager)
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)

    const pending = getHandler('speech:downloadModel')({ sender: { id: 7 } }, 'model-1')
    closeHandlers[0]?.()
    resolveDownload()
    await pending

    expect(clearProgressCallback).toHaveBeenCalledTimes(1)
    expect(window.off).toHaveBeenCalledWith('closed', expect.any(Function))
  })

  it('routes desktop model deletion through the shared deletion helper', async () => {
    const store = {} as never
    const manager = { deleteModel: vi.fn() }
    const sttService = { prepareModelForDeletion: vi.fn() }
    getSpeechModelManagerMock.mockReturnValue(manager)
    getSpeechSttServiceMock.mockReturnValue(sttService)
    deleteLocalSpeechModelMock.mockResolvedValue(undefined)
    registerSpeechHandlers(store)

    await getHandler('speech:deleteModel')({ sender: { id: 7 } }, 'model-1')

    expect(deleteLocalSpeechModelMock).toHaveBeenCalledWith({
      store,
      modelManager: manager,
      sttService,
      modelId: 'model-1'
    })
  })

  it('waits for bridged API-key persistence before returning status', async () => {
    let finishSave!: () => void
    saveOpenAiSpeechApiKeyMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSave = resolve
      })
    )
    registerSpeechHandlers({} as never)
    let settled = false
    const saving = getHandler('speech:saveOpenAiApiKey')({ sender: { id: 7 } }, 'sk-test').then(
      () => {
        settled = true
      }
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(getOpenAiSpeechApiKeySnapshotMock).not.toHaveBeenCalled()
    getOpenAiSpeechApiKeySnapshotMock.mockReturnValue({
      value: true,
      stale: false,
      age: 0,
      availability: 'ready'
    })
    finishSave()
    await saving
    expect(getOpenAiSpeechApiKeySnapshotMock).toHaveBeenCalledOnce()
  })

  it('propagates a rejected bridged API-key clear without publishing status', async () => {
    clearOpenAiSpeechApiKeyMock.mockRejectedValueOnce(new Error('contended'))
    registerSpeechHandlers({} as never)

    await expect(getHandler('speech:clearOpenAiApiKey')({ sender: { id: 7 } })).rejects.toThrow(
      'contended'
    )

    expect(getOpenAiSpeechApiKeySnapshotMock).not.toHaveBeenCalled()
  })
})
