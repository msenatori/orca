import { describe, expect, it, vi } from 'vitest'
import type {
  FilesystemHostOperation,
  FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostProcessError } from './filesystem-host-process'
import type { FilesystemHostTelemetryEvent } from './filesystem-host-telemetry'
import type { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

type ProcessHandle = {
  invoke(
    operation: FilesystemHostOperation,
    deadlineMs: number,
    requestId?: string
  ): Promise<FilesystemHostResult>
  retire(): Promise<boolean>
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function canonical(path: string): FilesystemHostResult {
  return { kind: 'canonicalize-path', canonicalPath: path }
}

function dispatch(path: string, operationId: string, admission: 'foreground' | 'background') {
  return {
    operationId,
    operation: { kind: 'canonicalize-path' as const, path },
    executionHost: 'native' as const,
    storageClass: 'workspace' as const,
    admission,
    deadlineMs: 100
  }
}

describe('FilesystemHostSupervisor', () => {
  it('serializes one unknown failure-domain lane and reuses its child', async () => {
    const first = deferred<FilesystemHostResult>()
    const invoke = vi
      .fn<ProcessHandle['invoke']>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(canonical('/unknown/b'))
    const retire = vi.fn(async () => true)
    const startProcess = vi.fn(async () => ({ invoke, retire }))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    const firstCall = supervisor.dispatch(dispatch('/unknown/a', 'first', 'foreground'))
    const secondCall = supervisor.dispatch(dispatch('/elsewhere/b', 'second', 'foreground'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    first.resolve(canonical('/unknown/a'))

    await expect(firstCall).resolves.toEqual(canonical('/unknown/a'))
    await expect(secondCall).resolves.toEqual(canonical('/unknown/b'))
    expect(startProcess).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('admits queued foreground work before older background work', async () => {
    const first = deferred<FilesystemHostResult>()
    const order: string[] = []
    const invoke = vi.fn(
      async (operation: FilesystemHostOperation, _deadlineMs: number, requestId?: string) => {
        order.push(requestId ?? '')
        if (requestId === 'running-background') {
          return first.promise
        }
        return canonical(operation.path)
      }
    )
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess: async () => ({ invoke, retire: async () => true })
    })

    const running = supervisor.dispatch(
      dispatch('/unknown/running', 'running-background', 'background')
    )
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const background = supervisor.dispatch(
      dispatch('/unknown/background', 'queued-background', 'background')
    )
    const foreground = supervisor.dispatch(
      dispatch('/unknown/foreground', 'queued-foreground', 'foreground')
    )
    first.resolve(canonical('/unknown/running'))

    await Promise.all([running, background, foreground])
    expect(order).toEqual(['running-background', 'queued-foreground', 'queued-background'])
  })

  it('runs verified independent mounts concurrently', async () => {
    const invocations: ReturnType<typeof deferred<FilesystemHostResult>>[] = []
    const startProcess = vi.fn(async () => {
      const next = deferred<FilesystemHostResult>()
      invocations.push(next)
      return { invoke: () => next.promise, retire: async () => true }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    const a = supervisor.dispatch(dispatch('/a/repo', 'a', 'foreground'))
    const b = supervisor.dispatch(dispatch('/b/repo', 'b', 'foreground'))
    await vi.waitFor(() => expect(invocations).toHaveLength(2))
    invocations[0].resolve(canonical('/a/repo'))
    invocations[1].resolve(canonical('/b/repo'))

    await expect(Promise.all([a, b])).resolves.toHaveLength(2)
  })

  it('keeps the final physical slot available to foreground work', async () => {
    const exits: (() => void)[] = []
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => {
      exits.push(() => options.onPhysicalExit?.())
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire: async () => true
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 2,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await supervisor.dispatch(dispatch('/a/repo', 'a', 'background'))
    await expect(
      supervisor.dispatch(dispatch('/b/repo', 'b-bg', 'background'))
    ).rejects.toMatchObject({ code: 'capacity' })
    await expect(supervisor.dispatch(dispatch('/b/repo', 'b-fg', 'foreground'))).resolves.toEqual(
      canonical('/b/repo')
    )
    expect(supervisor.health().physicalChildren).toBe(2)
    exits.forEach((exit) => exit())
  })

  it('opens the breaker, bounds abandonment, and permits one delayed canary', async () => {
    let now = 100
    let launches = 0
    const exits: (() => void)[] = []
    const startProcess = vi.fn(async (options: { onPhysicalExit?: () => void }) => {
      launches++
      exits.push(() => options.onPhysicalExit?.())
      if (launches === 1) {
        return {
          invoke: async () => {
            throw new FilesystemHostProcessError('deadline', 'timed out')
          },
          retire: async () => false
        }
      }
      return {
        invoke: async (operation: FilesystemHostOperation) => canonical(operation.path),
        retire: async () => true
      }
    })
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 3,
      breakerRecoveryDelayMs: 1_000,
      now: () => now,
      startProcess
    })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/a', mountId: 'a' })
    supervisor.publishFailureDomain({ executionHost: 'native', prefix: '/b', mountId: 'b' })

    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'timeout', 'foreground'))
    ).rejects.toMatchObject({ code: 'deadline' })
    await vi.waitFor(() => expect(supervisor.health().didNotExitDomains).toBe(1))
    expect(supervisor.health()).toMatchObject({
      physicalChildren: 1,
      abandonedChildren: 1,
      breakers: { 'native:a': 'open' }
    })
    await expect(
      supervisor.dispatch(dispatch('/a/repo', 'open', 'foreground'))
    ).rejects.toMatchObject({ code: 'breaker-open' })

    now = 1_100
    await expect(supervisor.dispatch(dispatch('/a/repo', 'canary', 'foreground'))).resolves.toEqual(
      canonical('/a/repo')
    )
    expect(supervisor.health().breakers['native:a']).toBe('closed')
    await expect(
      supervisor.dispatch(dispatch('/b/repo', 'background', 'background'))
    ).rejects.toMatchObject({ code: 'capacity' })
    await expect(
      supervisor.dispatch(dispatch('/b/repo', 'foreground', 'foreground'))
    ).resolves.toEqual(canonical('/b/repo'))
    expect(supervisor.health().physicalChildren).toBe(3)
    exits.forEach((exit) => exit())
  })

  it('keeps domain errors on the healthy child and emits path-free telemetry', async () => {
    const events: FilesystemHostTelemetryEvent[] = []
    const invoke = vi
      .fn<ProcessHandle['invoke']>()
      .mockRejectedValueOnce(new FilesystemHostProcessError('operation', 'missing', 'missing'))
      .mockResolvedValueOnce(canonical('/secret/repo'))
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess: async () => ({ invoke, retire: async () => true }),
      onTelemetry: (event) => events.push(event)
    })

    await expect(
      supervisor.dispatch(dispatch('/secret/repo', 'domain-error', 'foreground'))
    ).rejects.toEqual(
      expect.objectContaining<Partial<FilesystemHostSupervisorError>>({
        code: 'operation',
        operationCode: 'missing'
      })
    )
    await expect(
      supervisor.dispatch(dispatch('/secret/repo', 'success', 'foreground'))
    ).resolves.toEqual(canonical('/secret/repo'))

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(events)).not.toContain('/secret/repo')
    expect(events.map((event) => event.result)).toEqual(['domain-error', 'success'])
  })

  it('rejects SSH and misrouted WSL work before allocating a child', async () => {
    const startProcess = vi.fn()
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    await expect(
      supervisor.dispatch({
        ...dispatch('/remote/repo', 'ssh', 'foreground'),
        executionHost: 'ssh' as never
      })
    ).rejects.toMatchObject({ code: 'remote-host' })
    await expect(
      supervisor.dispatch({
        ...dispatch('/mnt/c/repo', 'wsl', 'foreground'),
        storageClass: 'wsl'
      })
    ).rejects.toMatchObject({ code: 'remote-host' })
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('schema-validates operations in main before allocating a child', async () => {
    const startProcess = vi.fn()
    const supervisor = new FilesystemHostSupervisor({
      entryPath: 'unused',
      maximumChildren: 8,
      startProcess
    })

    await expect(
      supervisor.dispatch({
        ...dispatch('/repo', 'invalid', 'foreground'),
        operation: { kind: 'read-file', path: '/repo/secret' } as never
      })
    ).rejects.toMatchObject({ code: 'operation' })
    expect(startProcess).not.toHaveBeenCalled()
  })
})
