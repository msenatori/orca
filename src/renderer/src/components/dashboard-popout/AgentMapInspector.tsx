import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentChatPanel } from './AgentChatPanel'
import { AgentTerminalPanel, type AgentRevealArgs } from './AgentTerminalDialog'

type AgentMapInspectorProps = {
  card: DashboardCard
  side: 'left' | 'right'
  onOpenChange: (open: boolean) => void
  onReveal: (args: AgentRevealArgs) => void
  reviewed: boolean
  pinned: boolean
  onMarkReviewed: (card: DashboardCard) => void
  onTogglePinned: (card: DashboardCard) => void
}

export function AgentMapInspector({
  card,
  side,
  onOpenChange,
  onReveal,
  reviewed,
  pinned,
  onMarkReviewed,
  onTogglePinned
}: AgentMapInspectorProps): React.JSX.Element {
  const [showTerminal, setShowTerminal] = useState(card.viewMode !== 'chat')
  const className = cn(
    side === 'right' ? 'ml-0' : 'mr-0',
    'animate-in fade-in-0 duration-200 motion-reduce:animate-none',
    side === 'right' ? 'slide-in-from-right-2' : 'slide-in-from-left-2'
  )

  if (!showTerminal) {
    return (
      <AgentChatPanel
        card={card}
        onClose={() => onOpenChange(false)}
        onOpenTerminal={() => setShowTerminal(true)}
        className={className}
      />
    )
  }

  return (
    <AgentTerminalPanel
      card={card}
      onOpenChange={onOpenChange}
      onReveal={onReveal}
      reviewed={reviewed}
      pinned={pinned}
      onMarkReviewed={onMarkReviewed}
      onTogglePinned={onTogglePinned}
      className={className}
    />
  )
}
