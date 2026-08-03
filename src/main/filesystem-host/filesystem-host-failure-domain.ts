import { resolve, sep, win32 } from 'node:path'

export type FilesystemExecutionHost = 'native' | 'windows-host'

type Mapping = {
  executionHost: FilesystemExecutionHost
  prefix: string
  mountId: string
}

function normalize(executionHost: FilesystemExecutionHost, value: string): string {
  const normalized = executionHost === 'windows-host' ? win32.resolve(value) : resolve(value)
  return executionHost === 'windows-host' ? normalized.toLowerCase() : normalized
}

function containsPath(
  executionHost: FilesystemExecutionHost,
  prefix: string,
  value: string
): boolean {
  const separator = executionHost === 'windows-host' ? win32.sep : sep
  return (
    value === prefix ||
    value.startsWith(prefix.endsWith(separator) ? prefix : `${prefix}${separator}`)
  )
}

export class FilesystemFailureDomainRegistry {
  private mappings: Mapping[] = []

  publish(mapping: Mapping): void {
    const normalized = normalize(mapping.executionHost, mapping.prefix)
    this.mappings = [
      ...this.mappings.filter(
        (candidate) =>
          candidate.executionHost !== mapping.executionHost || candidate.prefix !== normalized
      ),
      { ...mapping, prefix: normalized }
    ].sort((left, right) => right.prefix.length - left.prefix.length)
  }

  resolve(executionHost: FilesystemExecutionHost, path: string): string {
    const normalized = normalize(executionHost, path)
    const mapping = this.mappings.find(
      (candidate) =>
        candidate.executionHost === executionHost &&
        containsPath(executionHost, candidate.prefix, normalized)
    )
    return `${executionHost}:${mapping?.mountId ?? 'unknown'}`
  }

  clearHost(executionHost: FilesystemExecutionHost): void {
    this.mappings = this.mappings.filter((mapping) => mapping.executionHost !== executionHost)
  }
}
