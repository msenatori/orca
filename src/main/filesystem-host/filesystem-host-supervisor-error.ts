export type FilesystemHostSupervisorFailureCode =
  | 'breaker-open'
  | 'capacity'
  | 'queue-full'
  | 'remote-host'
  | 'deadline'
  | 'outcome-unknown'
  | 'quarantined'
  | 'unavailable'
  | 'operation'

export class FilesystemHostSupervisorError extends Error {
  constructor(
    readonly code: FilesystemHostSupervisorFailureCode,
    message: string,
    readonly operationCode?: string
  ) {
    super(message)
    this.name = 'FilesystemHostSupervisorError'
  }
}
