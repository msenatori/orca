const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function assertPackagedFilesystemHostEntryExists(resourcesDir) {
  const entryPath = join(
    resourcesDir,
    'app.asar.unpacked',
    'out',
    'main',
    'filesystem-host-entry.js'
  )
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] missing unpacked entry at ${entryPath}`
    )
  }
  return entryPath
}

function verifyPackagedFilesystemHostEntryBoots(resourcesDir, options = {}) {
  const entryPath = assertPackagedFilesystemHostEntryExists(resourcesDir)
  const result = spawnSync(options.execPath || process.execPath, [entryPath, '--self-test'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {}
  })
  if (result.error) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] launch failed: ${result.error.message}`
    )
  }
  if (result.status !== 0 || !result.stdout.includes('"protocolVersion":1')) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] self-test failed: ${result.stderr || result.stdout}`
    )
  }
  console.log('[verify-packaged-filesystem-host-entry] OK')
}

module.exports = {
  assertPackagedFilesystemHostEntryExists,
  verifyPackagedFilesystemHostEntryBoots
}
