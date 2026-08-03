import { setFilesystemHostReadClientForTests } from '../src/main/filesystem-host/filesystem-host-read-authority'

setFilesystemHostReadClientForTests({
  canonicalizePath: async (path) => (await import('node:fs/promises')).realpath(path),
  readOrcaYaml: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
  readKeybindings: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
  readSnapshotFile: async (path) => (await import('node:fs/promises')).readFile(path),
  prepareRateLimitPtyCwd: async (path) => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(path, { recursive: true })
    return fs.realpath(path)
  }
})
