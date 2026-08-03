import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import verifier from './verify-packaged-filesystem-host-entry.cjs'

const { assertPackagedFilesystemHostEntryExists, verifyPackagedFilesystemHostEntryBoots } = verifier

describe('packaged filesystem host entry verification', () => {
  const roots = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createResources(source) {
    const root = mkdtempSync(join(tmpdir(), 'orca-packaged-filesystem-host-'))
    roots.push(root)
    const entry = join(root, 'app.asar.unpacked', 'out', 'main', 'filesystem-host-entry.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, source)
    return root
  }

  it('fails when the unpacked entry is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-packaged-filesystem-host-missing-'))
    roots.push(root)
    expect(() => assertPackagedFilesystemHostEntryExists(root)).toThrow(/missing unpacked entry/)
  })

  it('boots the real packaged-layout entry under plain Node', () => {
    const resources = createResources(
      `process.stdout.write(JSON.stringify({ protocolVersion: 1 }) + '\\n')\n`
    )
    expect(() => verifyPackagedFilesystemHostEntryBoots(resources)).not.toThrow()
  })

  it('rejects an entry that loads but misses the protocol self-test', () => {
    const resources = createResources(`process.stdout.write('wrong\\n')\n`)
    expect(() => verifyPackagedFilesystemHostEntryBoots(resources)).toThrow(/self-test failed/)
  })
})
