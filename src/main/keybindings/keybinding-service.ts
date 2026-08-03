import {
  LEGACY_TAB_SWITCH_BINDINGS,
  type KeybindingActionId,
  type KeybindingFileSnapshot,
  type KeybindingOverrides
} from '../../shared/keybindings'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  migrateLegacyKeybindings,
  parseKeybindingFileContents,
  seedLegacyTabSwitchBindings,
  writeKeybindingOverride
} from './keybinding-file'
import { readKeybindingsThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  /** Cohort seed for the tab-switch convention swap. `isPending` is true only
   *  for pre-existing installs on the first launch after the swap; `markSeeded`
   *  freezes the one-shot so it never runs again. */
  legacyTabSwitchSeed?: {
    isPending: () => boolean
    markSeeded: () => void
  }
}

const FILESYSTEM_HOST_DIAGNOSTIC_SECTION = 'filesystem-host'

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.snapshot = parseKeybindingFileContents(this.configPath, null, this.platform)
    // Why: older builds persisted custom shortcuts inside global settings.
    // Once a keybindings file exists, it is the sole source of truth.
    migrateLegacyKeybindings(this.configPath, this.platform, options.getLegacyOverrides?.())
    // Why: pre-existing installs keep the old tab-switch chords. Only mark the
    // one-shot done on success so a transient IO failure retries next launch
    // instead of silently dropping the pin.
    if (options.legacyTabSwitchSeed?.isPending()) {
      try {
        // Why: the seed already read the file to build its snapshot — prime the
        // lazy cache with it instead of re-reading on the first getSnapshot().
        this.snapshot = seedLegacyTabSwitchBindings(
          this.configPath,
          this.platform,
          LEGACY_TAB_SWITCH_BINDINGS
        ).snapshot
        options.legacyTabSwitchSeed.markSeeded()
      } catch (error) {
        console.error('Failed to seed legacy tab-switch keybindings:', error)
      }
    }
  }

  getPath(): string {
    return this.configPath
  }

  getSnapshot(): KeybindingFileSnapshot {
    return this.snapshot
  }

  async hydrate(): Promise<KeybindingFileSnapshot> {
    let contents: string | null
    try {
      contents = await readKeybindingsThroughFilesystemHost(this.configPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        contents = null
      } else {
        this.snapshot = {
          ...this.snapshot,
          diagnostics: [
            ...this.snapshot.diagnostics.filter(
              (diagnostic) => diagnostic.section !== FILESYSTEM_HOST_DIAGNOSTIC_SECTION
            ),
            {
              severity: 'warning',
              section: FILESYSTEM_HOST_DIAGNOSTIC_SECTION,
              message:
                'Keybindings could not be refreshed; Orca is using the last available shortcuts.'
            }
          ]
        }
        return this.snapshot
      }
    }
    this.snapshot = parseKeybindingFileContents(this.configPath, contents, this.platform)
    return this.snapshot
  }

  reload(): Promise<KeybindingFileSnapshot> {
    return this.hydrate()
  }

  getOverrides(): KeybindingOverrides {
    return this.getSnapshot().overrides
  }

  async ensureFile(): Promise<KeybindingFileSnapshot> {
    ensureKeybindingFile(this.configPath)
    return await this.reload()
  }

  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): KeybindingFileSnapshot {
    this.snapshot = writeKeybindingOverride(this.configPath, this.platform, actionId, bindings)
    return this.snapshot
  }
}
