import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename } from 'node:path'
import { hardenExistingSecureFile } from '../../shared/secure-file'
import type {
  FilesystemHostErrorCode,
  FilesystemHostOperation,
  FilesystemHostResult,
  FilesystemSnapshotFileKind
} from '../../shared/filesystem-host-protocol'
import { FILESYSTEM_HOST_MAX_TEXT_BYTES } from '../../shared/filesystem-host-protocol'

export class FilesystemHostOperationError extends Error {
  constructor(
    readonly code: FilesystemHostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FilesystemHostOperationError'
  }
}

function prepareRateLimitPtyCwd(path: string): FilesystemHostResult {
  if (basename(path) !== 'rate-limit-pty-cwd') {
    throw new FilesystemHostOperationError('invalid', 'Expected a rate-limit PTY cwd path')
  }
  try {
    mkdirSync(path, { recursive: true })
    const canonicalPath = realpathSync.native(path)
    if (!statSync(canonicalPath).isDirectory()) {
      throw new FilesystemHostOperationError('invalid', 'Expected a rate-limit PTY cwd directory')
    }
    return { kind: 'prepare-rate-limit-pty-cwd', canonicalPath }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  }
}

function classifyError(error: unknown): FilesystemHostOperationError {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const classified: FilesystemHostErrorCode =
    code === 'ENOENT'
      ? 'missing'
      : code === 'EACCES' || code === 'EPERM'
        ? 'denied'
        : code === 'ENOTDIR' || code === 'EISDIR'
          ? 'not-directory'
          : code === 'EINVAL'
            ? 'invalid'
            : 'io'
  return new FilesystemHostOperationError(
    classified,
    `Filesystem operation failed${code ? ` (${code})` : ''}`
  )
}

function readBoundedTextFile(
  path: string,
  maxBytes: number,
  expectedBasename: string,
  kind: 'read-orca-yaml' | 'read-keybindings'
): FilesystemHostResult {
  if (basename(path).toLowerCase() !== expectedBasename) {
    throw new FilesystemHostOperationError('invalid', `Expected a ${expectedBasename} path`)
  }
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new FilesystemHostOperationError(
        'invalid',
        `Expected a regular ${expectedBasename} file`
      )
    }
    if (stat.size > maxBytes) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    const contents = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(contents) > maxBytes) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    return { kind, contents }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

const SNAPSHOT_BASENAME_BY_KIND: Record<FilesystemSnapshotFileKind, string> = {
  'claude-credentials': '.credentials.json',
  'codex-auth': 'auth.json',
  'gemini-auth': 'auth.json',
  'gemini-oauth-credentials': 'oauth_creds.json',
  'grok-auth': 'auth.json',
  'kimi-credentials': 'kimi-code.json',
  'minimax-cookie': 'minimax-session-cookie.enc'
}

function readBoundedSnapshotFile(
  path: string,
  fileKind: FilesystemSnapshotFileKind
): FilesystemHostResult {
  const expectedBasename = SNAPSHOT_BASENAME_BY_KIND[fileKind]
  if (basename(path).toLowerCase() !== expectedBasename) {
    throw new FilesystemHostOperationError('invalid', `Expected a ${expectedBasename} path`)
  }
  let descriptor: number | null = null
  try {
    if (fileKind === 'minimax-cookie') {
      try {
        hardenExistingSecureFile(path)
      } catch {
        // Why: legacy hydration treated read-time permission repair as best-effort.
      }
    }
    descriptor = openSync(path, constants.O_RDONLY)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new FilesystemHostOperationError(
        'invalid',
        `Expected a regular ${expectedBasename} file`
      )
    }
    if (stat.size > FILESYSTEM_HOST_MAX_TEXT_BYTES) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    const contents = readFileSync(descriptor)
    if (contents.byteLength > FILESYSTEM_HOST_MAX_TEXT_BYTES) {
      throw new FilesystemHostOperationError(
        'too-large',
        `${expectedBasename} exceeds the read limit`
      )
    }
    return { kind: 'read-snapshot-file', contentsBase64: contents.toString('base64') }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

export function executeFilesystemHostOperation(
  operation: FilesystemHostOperation
): FilesystemHostResult {
  try {
    switch (operation.kind) {
      case 'canonicalize-path':
        return {
          kind: 'canonicalize-path',
          canonicalPath: realpathSync.native(operation.path)
        }
      case 'classify-path':
        return { kind: 'classify-path', deviceId: String(statSync(operation.path).dev) }
      case 'read-orca-yaml':
        return readBoundedTextFile(operation.path, operation.maxBytes, 'orca.yaml', operation.kind)
      case 'read-keybindings':
        return readBoundedTextFile(
          operation.path,
          operation.maxBytes,
          'keybindings.json',
          operation.kind
        )
      case 'read-snapshot-file':
        return readBoundedSnapshotFile(operation.path, operation.fileKind)
      case 'prepare-rate-limit-pty-cwd':
        return prepareRateLimitPtyCwd(operation.path)
    }
  } catch (error) {
    if (error instanceof FilesystemHostOperationError) {
      throw error
    }
    throw classifyError(error)
  }
}
