import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalizePathThroughFilesystemHost,
  FilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from './filesystem-host-read-authority'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

afterEach(() => {
  setFilesystemHostReadClientForTests(null)
})

type TestSupervisor = NonNullable<
  ConstructorParameters<typeof FilesystemHostReadAuthority>[0]['supervisor']
>

function createSupervisor(dispatch: ReturnType<typeof vi.fn>): TestSupervisor {
  return {
    dispatch: dispatch as TestSupervisor['dispatch'],
    publishFailureDomain: vi.fn(),
    dispose: vi.fn(async () => {})
  }
}

describe('FilesystemHostReadAuthority', () => {
  it('fails closed before production configuration', async () => {
    setFilesystemHostReadClientForTests(null)
    await expect(canonicalizePathThroughFilesystemHost('/repo')).rejects.toMatchObject({
      name: 'FilesystemHostReadError',
      code: 'EHOSTUNREACH',
      reason: 'unavailable'
    })
  })

  it('routes WSL and UNC paths to Windows-host lanes', async () => {
    const dispatch = vi.fn(async (input) => ({
      kind: 'canonicalize-path' as const,
      canonicalPath: input.operation.path
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await authority.canonicalizePath('\\\\wsl.localhost\\Ubuntu\\home\\repo')
    await authority.canonicalizePath('\\\\server\\share\\repo')

    expect(dispatch.mock.calls[0][0]).toMatchObject({
      executionHost: 'windows-host',
      storageClass: 'wsl',
      admission: 'foreground'
    })
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      executionHost: 'windows-host',
      storageClass: 'unc',
      admission: 'foreground'
    })
  })

  it('maps domain and deadline failures to compatible Node error codes', async () => {
    const denied = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(
        vi.fn(async () => {
          throw new FilesystemHostSupervisorError('operation', 'denied', 'denied')
        })
      )
    })
    const timedOut = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(
        vi.fn(async () => {
          throw new FilesystemHostSupervisorError('deadline', 'timeout')
        })
      )
    })

    await expect(denied.canonicalizePath('/repo')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(timedOut.canonicalizePath('/repo')).rejects.toEqual(
      expect.objectContaining({
        code: 'ETIMEDOUT',
        reason: 'deadline'
      })
    )
  })

  it('routes keybinding hydration as a bounded home read', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'read-keybindings' as const,
      contents: '{"version":1}'
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await expect(authority.readKeybindings('/home/alice/.orca/keybindings.json')).resolves.toBe(
      '{"version":1}'
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: 'read-keybindings' }),
        storageClass: 'home',
        admission: 'foreground'
      })
    )
  })

  it('routes snapshot files and PTY cwd preparation through bounded typed operations', async () => {
    const dispatch = vi.fn(async (input) =>
      input.operation.kind === 'read-snapshot-file'
        ? {
            kind: 'read-snapshot-file' as const,
            contentsBase64: Buffer.from('token').toString('base64')
          }
        : {
            kind: 'prepare-rate-limit-pty-cwd' as const,
            canonicalPath: input.operation.path
          }
    )
    const authority = new FilesystemHostReadAuthority({
      entryPath: '/unused',
      supervisor: createSupervisor(dispatch)
    })

    await expect(
      authority.readSnapshotFile('/home/alice/.grok/auth.json', 'grok-auth')
    ).resolves.toEqual(Buffer.from('token'))
    await expect(authority.prepareRateLimitPtyCwd('/profile/rate-limit-pty-cwd')).resolves.toBe(
      '/profile/rate-limit-pty-cwd'
    )
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      operation: { kind: 'read-snapshot-file', fileKind: 'grok-auth' },
      storageClass: 'home',
      admission: 'background'
    })
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      operation: { kind: 'prepare-rate-limit-pty-cwd' },
      storageClass: 'user-data',
      admission: 'background'
    })
  })

  it('classifies known prefixes away from dispatch and publishes their device lanes', async () => {
    const publishFailureDomain = vi.fn()
    const dispatch = vi.fn(async () => ({ kind: 'classify-path' as const, deviceId: 'device-7' }))
    const supervisor = {
      ...createSupervisor(dispatch),
      publishFailureDomain
    }
    const authority = new FilesystemHostReadAuthority({ entryPath: '/unused', supervisor })

    authority.hydrateFailureDomains(['/repo', '/repo'])
    await vi.waitFor(() => expect(publishFailureDomain).toHaveBeenCalledTimes(1))

    expect(publishFailureDomain).toHaveBeenCalledWith({
      executionHost: 'native',
      prefix: '/repo',
      mountId: 'device-7'
    })
  })
})
