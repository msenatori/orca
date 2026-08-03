import type { MemorySnapshot } from '../../shared/memory-snapshot'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'
import {
  readAuthJson,
  readGeminiCredentials,
  type GeminiCredentials,
  type GoogleAuthEntry,
  type RefreshTokenResult
} from './gemini-oauth-sources'
import { classifyFilesystemSnapshotFailure, MemorySnapshotStore } from './memory-snapshot-store'

type OAuthClientCredentials = {
  clientId: string
  clientSecret: string
}

export type GeminiOAuthPreparation =
  | {
      source: 'auth-json'
      auth: GoogleAuthEntry
      clientCredentials: OAuthClientCredentials | null
    }
  | {
      source: 'oauth-creds'
      credentials: GeminiCredentials
      clientCredentials: OAuthClientCredentials | null
    }

let preparationStore = new MemorySnapshotStore<GeminiOAuthPreparation>()

async function loadPreparation(): Promise<{
  value: GeminiOAuthPreparation | null
  availability: 'ready' | 'missing'
}> {
  const authJson = await readAuthJson()
  const auth = authJson?.google?.type === 'oauth' ? authJson.google : null
  const credentials = auth ? null : await readGeminiCredentials()
  if (!auth && !credentials) {
    return { value: null, availability: 'missing' }
  }
  const clientCredentials = await extractOAuthClientCredentials()
  return {
    value: auth
      ? { source: 'auth-json', auth, clientCredentials }
      : { source: 'oauth-creds', credentials: credentials!, clientCredentials },
    availability: 'ready'
  }
}

export function getGeminiOAuthPreparationSnapshot(): MemorySnapshot<GeminiOAuthPreparation> {
  return preparationStore.get()
}

export async function hydrateGeminiOAuthPreparationSnapshot(
  enabled: boolean
): Promise<MemorySnapshot<GeminiOAuthPreparation>> {
  if (!enabled) {
    preparationStore.revoke()
    return preparationStore.get()
  }
  return preparationStore.refresh(loadPreparation, classifyFilesystemSnapshotFailure)
}

function refreshedTokenExpiry(expiresIn: number | undefined, fallback: number): number {
  return expiresIn === undefined ? fallback : Date.now() + expiresIn * 1000
}

function refreshedAuthValue(
  preparation: Extract<GeminiOAuthPreparation, { source: 'auth-json' }>,
  result: RefreshTokenResult
): GeminiOAuthPreparation {
  const refreshParts = preparation.auth.refresh.split('|')
  if (result.newRefreshToken) {
    refreshParts[0] = result.newRefreshToken
  }
  return {
    ...preparation,
    auth: {
      ...preparation.auth,
      access: result.accessToken!,
      expires: refreshedTokenExpiry(result.expiresIn, preparation.auth.expires),
      refresh: refreshParts.join('|')
    }
  }
}

function refreshedCredentialsValue(
  preparation: Extract<GeminiOAuthPreparation, { source: 'oauth-creds' }>,
  result: RefreshTokenResult
): GeminiOAuthPreparation {
  return {
    ...preparation,
    credentials: {
      ...preparation.credentials,
      access_token: result.accessToken!,
      refresh_token: result.newRefreshToken ?? preparation.credentials.refresh_token,
      expiry_date: refreshedTokenExpiry(result.expiresIn, preparation.credentials.expiry_date)
    }
  }
}

export function publishGeminiOAuthTokenRefresh(
  preparation: GeminiOAuthPreparation,
  result: RefreshTokenResult
): void {
  const current = preparationStore.get()
  if (!result.accessToken || current.stale || current.value !== preparation) {
    return
  }
  preparationStore.publishOwned({
    value:
      preparation.source === 'auth-json'
        ? refreshedAuthValue(preparation, result)
        : refreshedCredentialsValue(preparation, result),
    availability: 'ready'
  })
}

export function resetGeminiOAuthPreparationSnapshotForTests(): void {
  preparationStore = new MemorySnapshotStore<GeminiOAuthPreparation>()
}
