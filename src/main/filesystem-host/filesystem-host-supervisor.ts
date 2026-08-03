import {
  filesystemHostOperationSchema,
  type FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostBreaker } from './filesystem-host-breaker'
import {
  FilesystemHostCapacity,
  processWideFilesystemHostCapacity,
  type FilesystemHostAdmissionClass
} from './filesystem-host-capacity'
import {
  FilesystemFailureDomainRegistry,
  type FilesystemExecutionHost
} from './filesystem-host-failure-domain'
import { FilesystemHostProcess, type FilesystemHostProcessOptions } from './filesystem-host-process'
import type { FilesystemHostTelemetryEvent } from './filesystem-host-telemetry'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { executeFilesystemHostDispatch } from './filesystem-host-supervisor-execution'
import {
  snapshotFilesystemHostSupervisorHealth,
  type FilesystemHostSupervisorHealth
} from './filesystem-host-supervisor-health'
import type {
  FilesystemHostDispatch,
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'
import { recordFilesystemHostSupervisorTelemetry } from './filesystem-host-supervisor-telemetry'

export type { FilesystemHostDispatch } from './filesystem-host-supervisor-scheduling'

type ProcessFactory = (
  options: FilesystemHostProcessOptions
) => Promise<FilesystemHostProcessHandle>

export type FilesystemHostSupervisorOptions = {
  entryPath: string
  maximumChildren?: number
  capacity?: FilesystemHostCapacity
  maximumPendingPerLane?: number
  breakerRecoveryDelayMs?: number
  now?: () => number
  startProcess?: ProcessFactory
  onTelemetry?: (event: FilesystemHostTelemetryEvent) => void
}

export class FilesystemHostSupervisor {
  private readonly capacity: FilesystemHostCapacity
  private readonly domains = new FilesystemFailureDomainRegistry()
  private readonly lanes = new Map<string, FilesystemHostLane>()
  private readonly abandoned = new Set<FilesystemHostProcessHandle>()
  private readonly didNotExitDomainByChild = new Map<FilesystemHostProcessHandle, string>()
  private readonly maximumPendingPerLane: number
  private readonly breakerRecoveryDelayMs: number
  private readonly now: () => number
  private readonly startProcess: ProcessFactory
  private disposed = false

  constructor(private readonly options: FilesystemHostSupervisorOptions) {
    this.capacity =
      options.capacity ??
      (options.maximumChildren !== undefined
        ? new FilesystemHostCapacity(options.maximumChildren)
        : processWideFilesystemHostCapacity)
    this.maximumPendingPerLane = options.maximumPendingPerLane ?? 64
    this.breakerRecoveryDelayMs = options.breakerRecoveryDelayMs ?? 30_000
    this.now = options.now ?? Date.now
    this.startProcess = options.startProcess ?? ((input) => FilesystemHostProcess.start(input))
  }

  publishFailureDomain(input: {
    executionHost: FilesystemExecutionHost
    prefix: string
    mountId: string
  }): void {
    this.domains.publish(input)
  }

  dispatch(input: FilesystemHostDispatch): Promise<FilesystemHostResult> {
    if (this.disposed) {
      return Promise.reject(
        new FilesystemHostSupervisorError('unavailable', 'Filesystem host supervisor is disposed')
      )
    }
    if (
      !['native', 'windows-host'].includes(input.executionHost) ||
      (['wsl', 'unc'].includes(input.storageClass) && input.executionHost !== 'windows-host')
    ) {
      return Promise.reject(
        new FilesystemHostSupervisorError(
          'remote-host',
          'Remote filesystem paths require their owning provider'
        )
      )
    }
    const parsedOperation = filesystemHostOperationSchema.safeParse(input.operation)
    if (!parsedOperation.success) {
      return Promise.reject(
        new FilesystemHostSupervisorError('operation', 'Invalid filesystem host operation')
      )
    }
    if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
      return Promise.reject(
        new FilesystemHostSupervisorError('deadline', 'A positive filesystem deadline is required')
      )
    }
    const normalizedInput = { ...input, operation: parsedOperation.data }
    const laneKey = this.domains.resolve(
      normalizedInput.executionHost,
      normalizedInput.operation.path
    )
    const lane = this.getLane(laneKey)
    if (lane.pending >= this.maximumPendingPerLane) {
      return Promise.reject(
        new FilesystemHostSupervisorError('queue-full', 'Filesystem failure-domain queue is full')
      )
    }
    lane.pending++
    return new Promise((resolve, reject) => {
      lane[normalizedInput.admission].push({ input: normalizedInput, resolve, reject })
      this.pump(lane)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const lane of this.lanes.values()) {
      const failure = new FilesystemHostSupervisorError(
        'unavailable',
        'Filesystem host supervisor is disposed'
      )
      for (const job of [...lane.foreground.splice(0), ...lane.background.splice(0)]) {
        lane.pending--
        job.reject(failure)
      }
    }
    const processes = [...this.lanes.values()]
      .map((lane) => lane.process)
      .filter((process): process is FilesystemHostProcessHandle => process !== null)
    for (const lane of this.lanes.values()) {
      lane.process = null
    }
    await Promise.all(processes.map((process) => process.retire()))
  }

  health(): FilesystemHostSupervisorHealth {
    return snapshotFilesystemHostSupervisorHealth({
      physicalChildren: this.capacity.reservedCount,
      abandoned: this.abandoned,
      didNotExitDomainByChild: this.didNotExitDomainByChild,
      lanes: this.lanes
    })
  }

  private getLane(key: string): FilesystemHostLane {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = {
        key,
        breaker: new FilesystemHostBreaker(this.breakerRecoveryDelayMs),
        process: null,
        foreground: [],
        background: [],
        running: false,
        pending: 0
      }
      this.lanes.set(key, lane)
    }
    return lane
  }

  private pump(lane: FilesystemHostLane): void {
    if (lane.running || this.disposed) {
      return
    }
    const job = lane.foreground.shift() ?? lane.background.shift()
    if (!job) {
      return
    }
    lane.running = true
    void executeFilesystemHostDispatch(
      {
        now: this.now,
        launch: (targetLane, admission) => this.launch(targetLane, admission),
        abandon: (laneKey, targetLane, process) => this.abandon(laneKey, targetLane, process),
        recordTelemetry: (input, targetLane, startedAt, result) =>
          recordFilesystemHostSupervisorTelemetry({
            dispatch: input,
            lane: targetLane,
            startedAt,
            result,
            now: this.now,
            abandonedChildren: this.abandoned.size,
            emit: this.options.onTelemetry
          })
      },
      lane,
      job
    )
      .then(job.resolve, job.reject)
      .finally(() => {
        lane.pending--
        lane.running = false
        this.pump(lane)
      })
  }

  private async launch(
    lane: FilesystemHostLane,
    admission: FilesystemHostAdmissionClass
  ): Promise<FilesystemHostProcessHandle> {
    const release = this.capacity.reserve(admission)
    if (!release) {
      throw new FilesystemHostSupervisorError(
        'capacity',
        'Physical filesystem host capacity is exhausted'
      )
    }
    let process: FilesystemHostProcessHandle | null = null
    process = await this.startProcess({
      entryPath: this.options.entryPath,
      onPhysicalExit: () => {
        release()
        if (process) {
          this.abandoned.delete(process)
          this.didNotExitDomainByChild.delete(process)
        }
        if (lane.process === process) {
          lane.process = null
        }
      }
    })
    lane.process = process
    return process
  }

  private abandon(
    laneKey: string,
    lane: FilesystemHostLane,
    process: FilesystemHostProcessHandle
  ): void {
    if (lane.process === process) {
      lane.process = null
    }
    this.abandoned.add(process)
    void process.retire().then((didExit) => {
      if (!didExit) {
        this.didNotExitDomainByChild.set(process, laneKey)
      }
    })
  }
}
