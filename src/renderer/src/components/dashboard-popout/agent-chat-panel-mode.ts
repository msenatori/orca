// Pure: decide what the pop-out chat panel can honestly show for a card.

import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

export type AgentChatPanelMode =
  | { kind: 'live'; sessionId: string; transcriptPath: string | null }
  | { kind: 'degraded'; reason: 'no-session' | 'remote-host' }

/**
 * The pop-out reads transcripts over the local IPC bridge, so an ssh/remote
 * pane's path would resolve against this machine and silently read nothing.
 * Those cards, and cards whose agent has not reported a session yet, fall back
 * to the snapshot's own last message rather than an empty transcript.
 */
export function resolveAgentChatPanelMode(card: DashboardCard): AgentChatPanelMode {
  if (card.hostKind === 'ssh' || card.hostKind === 'remote') {
    return { kind: 'degraded', reason: 'remote-host' }
  }
  if (!card.sessionId) {
    return { kind: 'degraded', reason: 'no-session' }
  }
  return { kind: 'live', sessionId: card.sessionId, transcriptPath: card.transcriptPath ?? null }
}
