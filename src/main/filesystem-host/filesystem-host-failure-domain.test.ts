import { describe, expect, it } from 'vitest'
import { FilesystemFailureDomainRegistry } from './filesystem-host-failure-domain'

describe('FilesystemFailureDomainRegistry', () => {
  it('uses the longest verified native prefix and one conservative unknown lane', () => {
    const registry = new FilesystemFailureDomainRegistry()
    registry.publish({ executionHost: 'native', prefix: '/work', mountId: 'device-a' })
    registry.publish({ executionHost: 'native', prefix: '/work/network', mountId: 'device-b' })

    expect(registry.resolve('native', '/work/network/repo/orca.yaml')).toBe('native:device-b')
    expect(registry.resolve('native', '/work/local/repo')).toBe('native:device-a')
    expect(registry.resolve('native', '/unknown/a')).toBe('native:unknown')
    expect(registry.resolve('native', '/another/b')).toBe('native:unknown')
  })

  it('classifies WSL and UNC paths on the case-insensitive Windows host', () => {
    const registry = new FilesystemFailureDomainRegistry()
    registry.publish({
      executionHost: 'windows-host',
      prefix: '\\\\wsl.localhost\\Ubuntu\\home',
      mountId: 'wsl-device'
    })

    expect(registry.resolve('windows-host', '\\\\WSL.LOCALHOST\\Ubuntu\\home\\ada\\repo')).toBe(
      'windows-host:wsl-device'
    )
    expect(registry.resolve('native', '/home/ada/repo')).toBe('native:unknown')
  })
})
