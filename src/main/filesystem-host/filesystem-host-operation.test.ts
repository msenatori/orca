import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executeFilesystemHostOperation,
  FilesystemHostOperationError
} from './filesystem-host-operation'

describe('executeFilesystemHostOperation', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-filesystem-host-'))
    roots.push(root)
    return root
  }

  it('reads a bounded orca.yaml through an opened descriptor', () => {
    const root = createRoot()
    const path = join(root, 'orca.yaml')
    writeFileSync(path, 'hooks:\n  enabled: true\n')

    expect(
      executeFilesystemHostOperation({ kind: 'read-orca-yaml', path, maxBytes: 1_024 })
    ).toEqual({ kind: 'read-orca-yaml', contents: 'hooks:\n  enabled: true\n' })
  })

  it('rejects general file reads and oversized YAML', () => {
    const root = createRoot()
    const unrelated = join(root, 'secrets.txt')
    const yaml = join(root, 'orca.yaml')
    writeFileSync(unrelated, 'secret')
    writeFileSync(yaml, '12345')

    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-orca-yaml',
        path: unrelated,
        maxBytes: 100
      })
    ).toThrowError(FilesystemHostOperationError)
    expect(() =>
      executeFilesystemHostOperation({ kind: 'read-orca-yaml', path: yaml, maxBytes: 4 })
    ).toThrowError(expect.objectContaining({ code: 'too-large' }))
  })

  it('reads only the typed bounded keybindings file', () => {
    const root = createRoot()
    const path = join(root, 'keybindings.json')
    writeFileSync(path, '{"version":1}')

    expect(
      executeFilesystemHostOperation({ kind: 'read-keybindings', path, maxBytes: 1_024 })
    ).toEqual({ kind: 'read-keybindings', contents: '{"version":1}' })
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-keybindings',
        path: join(root, 'settings.json'),
        maxBytes: 1_024
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('reads only declared snapshot files and preserves raw bytes', () => {
    const root = createRoot()
    const path = join(root, 'minimax-session-cookie.enc')
    const contents = Buffer.from([0, 1, 2, 255])
    writeFileSync(path, contents)

    expect(
      executeFilesystemHostOperation({
        kind: 'read-snapshot-file',
        path,
        fileKind: 'minimax-cookie'
      })
    ).toEqual({ kind: 'read-snapshot-file', contentsBase64: contents.toString('base64') })
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'read-snapshot-file',
        path: join(root, 'secrets.txt'),
        fileKind: 'minimax-cookie'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('prepares only the typed rate-limit PTY cwd', () => {
    const root = createRoot()
    const path = join(root, 'rate-limit-pty-cwd')

    expect(executeFilesystemHostOperation({ kind: 'prepare-rate-limit-pty-cwd', path })).toEqual({
      kind: 'prepare-rate-limit-pty-cwd',
      canonicalPath: expect.any(String)
    })
    expect(() =>
      executeFilesystemHostOperation({
        kind: 'prepare-rate-limit-pty-cwd',
        path: join(root, 'unrelated')
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))
  })

  it('canonicalizes and classifies existing paths', () => {
    const root = createRoot()

    const canonical = executeFilesystemHostOperation({ kind: 'canonicalize-path', path: root })
    const classified = executeFilesystemHostOperation({ kind: 'classify-path', path: root })

    expect(canonical).toEqual({ kind: 'canonicalize-path', canonicalPath: expect.any(String) })
    expect(classified).toEqual({ kind: 'classify-path', deviceId: expect.any(String) })
  })

  it('returns stable error classes without raw path disclosure', () => {
    const root = createRoot()
    const missing = join(root, 'missing')

    try {
      executeFilesystemHostOperation({ kind: 'canonicalize-path', path: missing })
      throw new Error('Expected canonicalization to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing' })
      expect((error as Error).message).not.toContain(missing)
    }
  })
})
