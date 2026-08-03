import { randomUUID } from 'node:crypto'
import { isWslUncPath } from '../../shared/wsl-paths'
import type {
  FilesystemHostResult,
  FilesystemSnapshotFileKind
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

const AUTHORIZATION_DEADLINE_MS = 2_000
const BACKGROUND_READ_DEADLINE_MS = 5_000
const UNC_PATH_PREFIX = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/

type Dispatch = FilesystemHostSupervisor['dispatch']
type PublishFailureDomain = FilesystemHostSupervisor['publishFailureDomain']

export type FilesystemHostReadClient = {
  canonicalizePath(path: string, storageClass?: FilesystemStorageClass): Promise<string>
  readOrcaYaml(path: string): Promise<string>
  readKeybindings(path: string): Promise<string>
  readSnapshotFile(path: string, fileKind: FilesystemSnapshotFileKind): Promise<Buffer>
  prepareRateLimitPtyCwd(path: string): Promise<string>
}

export type FilesystemHostReadAuthorityOptions = {
  entryPath: string
  supervisor?: {
    dispatch: Dispatch
    publishFailureDomain: PublishFailureDomain
    dispose(): Promise<void>
  }
}

export type FilesystemHostReadFailureReason =
  | 'missing'
  | 'denied'
  | 'not-directory'
  | 'too-large'
  | 'invalid'
  | 'deadline'
  | 'unavailable'

const NODE_ERROR_CODE_BY_REASON: Record<FilesystemHostReadFailureReason, string> = {
  missing: 'ENOENT',
  denied: 'EACCES',
  'not-directory': 'ENOTDIR',
  'too-large': 'EFBIG',
  invalid: 'EINVAL',
  deadline: 'ETIMEDOUT',
  unavailable: 'EHOSTUNREACH'
}

export class FilesystemHostReadError extends Error {
  readonly code: string

  constructor(readonly reason: FilesystemHostReadFailureReason) {
    super(
      reason === 'deadline'
        ? 'Filesystem operation timed out'
        : reason === 'unavailable'
          ? 'Filesystem host is unavailable'
          : `Filesystem read failed (${reason})`
    )
    this.name = 'FilesystemHostReadError'
    this.code = NODE_ERROR_CODE_BY_REASON[reason]
  }
}

function routePath(
  path: string,
  defaultStorageClass: FilesystemStorageClass
): {
  executionHost: 'native' | 'windows-host'
  storageClass: FilesystemStorageClass
} {
  if (isWslUncPath(path)) {
    return { executionHost: 'windows-host', storageClass: 'wsl' }
  }
  if (UNC_PATH_PREFIX.test(path)) {
    return { executionHost: 'windows-host', storageClass: 'unc' }
  }
  return { executionHost: 'native', storageClass: defaultStorageClass }
}

function failureReason(error: unknown): FilesystemHostReadFailureReason {
  if (!(error instanceof FilesystemHostSupervisorError)) {
    return 'unavailable'
  }
  if (error.code === 'deadline') {
    return 'deadline'
  }
  if (error.code !== 'operation') {
    return 'unavailable'
  }
  switch (error.operationCode) {
    case 'missing':
    case 'denied':
    case 'not-directory':
    case 'too-large':
    case 'invalid':
      return error.operationCode
    default:
      return 'unavailable'
  }
}

function requireResult<T extends FilesystemHostResult['kind']>(
  result: FilesystemHostResult,
  kind: T
): Extract<FilesystemHostResult, { kind: T }> {
  if (result.kind !== kind) {
    throw new FilesystemHostReadError('unavailable')
  }
  return result as Extract<FilesystemHostResult, { kind: T }>
}

export class FilesystemHostReadAuthority implements FilesystemHostReadClient {
  private readonly supervisor: NonNullable<FilesystemHostReadAuthorityOptions['supervisor']>

  constructor(options: FilesystemHostReadAuthorityOptions) {
    this.supervisor =
      options.supervisor ?? new FilesystemHostSupervisor({ entryPath: options.entryPath })
  }

  async canonicalizePath(
    path: string,
    storageClass: FilesystemStorageClass = 'workspace'
  ): Promise<string> {
    const route = routePath(path, storageClass)
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'canonicalize-path', path },
        ...route,
        admission: 'foreground',
        deadlineMs: AUTHORIZATION_DEADLINE_MS
      })
      return requireResult(result, 'canonicalize-path').canonicalPath
    } catch (error) {
      throw new FilesystemHostReadError(failureReason(error))
    }
  }

  async readOrcaYaml(path: string): Promise<string> {
    const route = routePath(path, 'workspace')
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'read-orca-yaml', path, maxBytes: 1024 * 1024 },
        ...route,
        admission: 'background',
        deadlineMs: BACKGROUND_READ_DEADLINE_MS
      })
      return requireResult(result, 'read-orca-yaml').contents
    } catch (error) {
      throw new FilesystemHostReadError(failureReason(error))
    }
  }

  async readKeybindings(path: string): Promise<string> {
    const route = routePath(path, 'home')
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'read-keybindings', path, maxBytes: 1024 * 1024 },
        ...route,
        admission: 'foreground',
        deadlineMs: BACKGROUND_READ_DEADLINE_MS
      })
      return requireResult(result, 'read-keybindings').contents
    } catch (error) {
      throw new FilesystemHostReadError(failureReason(error))
    }
  }

  async readSnapshotFile(path: string, fileKind: FilesystemSnapshotFileKind): Promise<Buffer> {
    const route = routePath(path, 'home')
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'read-snapshot-file', path, fileKind },
        ...route,
        admission: 'background',
        deadlineMs: BACKGROUND_READ_DEADLINE_MS
      })
      return Buffer.from(requireResult(result, 'read-snapshot-file').contentsBase64, 'base64')
    } catch (error) {
      throw new FilesystemHostReadError(failureReason(error))
    }
  }

  async prepareRateLimitPtyCwd(path: string): Promise<string> {
    const route = routePath(path, 'user-data')
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'prepare-rate-limit-pty-cwd', path },
        ...route,
        admission: 'background',
        deadlineMs: BACKGROUND_READ_DEADLINE_MS
      })
      return requireResult(result, 'prepare-rate-limit-pty-cwd').canonicalPath
    } catch (error) {
      throw new FilesystemHostReadError(failureReason(error))
    }
  }

  hydrateFailureDomains(paths: readonly string[]): void {
    for (const path of new Set(paths)) {
      void this.classifyAndPublish(path)
    }
  }

  dispose(): Promise<void> {
    return this.supervisor.dispose()
  }

  private async classifyAndPublish(path: string): Promise<void> {
    const route = routePath(path, 'workspace')
    try {
      const result = await this.supervisor.dispatch({
        operationId: randomUUID(),
        operation: { kind: 'classify-path', path },
        ...route,
        admission: 'background',
        deadlineMs: BACKGROUND_READ_DEADLINE_MS
      })
      const classified = requireResult(result, 'classify-path')
      this.supervisor.publishFailureDomain({
        executionHost: route.executionHost,
        prefix: path,
        mountId: classified.deviceId
      })
    } catch {
      // The conservative unknown lane remains authoritative until a later probe succeeds.
    }
  }
}

const READ_AUTHORITY_STATE_KEY = '__orcaFilesystemHostReadAuthorityState'

type FilesystemHostReadAuthorityState = {
  client: FilesystemHostReadClient | null
  authority: FilesystemHostReadAuthority | null
}

function getReadAuthorityState(): FilesystemHostReadAuthorityState {
  const scope = globalThis as unknown as Record<string, unknown>
  let state = scope[READ_AUTHORITY_STATE_KEY] as FilesystemHostReadAuthorityState | undefined
  if (!state) {
    state = { client: null, authority: null }
    scope[READ_AUTHORITY_STATE_KEY] = state
  }
  return state
}

export function configureFilesystemHostReadAuthority(authority: FilesystemHostReadAuthority): void {
  const state = getReadAuthorityState()
  state.client = authority
  state.authority = authority
}

export function setFilesystemHostReadClientForTests(client: FilesystemHostReadClient | null): void {
  const state = getReadAuthorityState()
  state.client = client
  state.authority = null
}

export function hydrateFilesystemHostFailureDomains(paths: readonly string[]): void {
  getReadAuthorityState().authority?.hydrateFailureDomains(paths)
}

function requireClient(): FilesystemHostReadClient {
  const client = getReadAuthorityState().client
  if (!client) {
    throw new FilesystemHostReadError('unavailable')
  }
  return client
}

export async function canonicalizePathThroughFilesystemHost(
  path: string,
  storageClass?: FilesystemStorageClass
): Promise<string> {
  return await requireClient().canonicalizePath(path, storageClass)
}

export async function readOrcaYamlThroughFilesystemHost(path: string): Promise<string> {
  return await requireClient().readOrcaYaml(path)
}

export async function readKeybindingsThroughFilesystemHost(path: string): Promise<string> {
  return await requireClient().readKeybindings(path)
}

export async function readSnapshotFileThroughFilesystemHost(
  path: string,
  fileKind: FilesystemSnapshotFileKind
): Promise<Buffer> {
  return await requireClient().readSnapshotFile(path, fileKind)
}

export async function prepareRateLimitPtyCwdThroughFilesystemHost(path: string): Promise<string> {
  return await requireClient().prepareRateLimitPtyCwd(path)
}
