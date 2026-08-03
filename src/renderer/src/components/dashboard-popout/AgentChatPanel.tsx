import { useId, useState } from 'react'
import { SquareTerminal, XIcon } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeChatMessageList } from '@/components/native-chat/NativeChatMessageList'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '@/components/native-chat/native-chat-send'
import { useNativeChatLiveSession } from '@/components/native-chat/use-native-chat-live-session'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { resolveAgentChatPanelMode, type AgentChatPanelMode } from './agent-chat-panel-mode'

type AgentChatPanelProps = {
  card: DashboardCard
  onClose: () => void
  onOpenTerminal?: () => void
  className?: string
}

function agentName(card: DashboardCard): string {
  return card.conversationName ?? (card.task.trim() || formatAgentTypeLabel(card.agentType))
}

/** Live transcript. Its own component so the session hook is never called for a
 *  card that has nothing to read. */
function AgentChatTranscript({
  card,
  sessionId,
  transcriptPath
}: {
  card: DashboardCard
  sessionId: string
  transcriptPath: string | null
}): React.JSX.Element {
  // Bucket, not the hook status: the store backing useNativeChatHookStatus is
  // empty in the pop-out renderer, so the snapshot is the only live signal here.
  const session = useNativeChatLiveSession({
    paneKey: card.paneKey,
    agent: card.agentType,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId: null
  })
  if (session.messages.length === 0 && session.readPhase !== 'loading') {
    return (
      <p className="grid flex-1 place-items-center px-4 text-center text-xs text-muted-foreground">
        {translate('dashboardPopout.chat.empty', 'No messages in this transcript yet.')}
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3">
      <NativeChatMessageList
        session={session}
        isWorking={card.bucket === 'working'}
        expandSignal={false}
        fontScale={1}
      />
    </div>
  )
}

/** What the panel shows when it cannot read the real transcript: the snapshot's
 *  own last message, plus the escalation to the terminal. */
function AgentChatFallback({
  card,
  reason
}: {
  card: DashboardCard
  reason: 'no-session' | 'remote-host'
}): React.JSX.Element {
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <p className="text-xs text-muted-foreground">
        {reason === 'remote-host'
          ? translate(
              'dashboardPopout.chat.remoteHost',
              'This agent runs on a remote host, so its transcript is not readable here.'
            )
          : translate(
              'dashboardPopout.chat.noSession',
              'This agent has not reported a session yet, so there is no transcript to read.'
            )}
      </p>
      {card.askSummary ? (
        <section className="rounded-lg border border-border bg-muted/40 p-3">
          <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.chat.pendingQuestion', 'Pending question')}
          </h3>
          <p className="text-xs whitespace-pre-wrap">{card.askSummary}</p>
        </section>
      ) : null}
      {card.lastAgentMessage ? (
        <section className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-[11px] font-semibold text-muted-foreground">
            {translate('dashboardPopout.chat.lastMessage', 'Last message')}
          </h3>
          <p className="text-xs whitespace-pre-wrap">{card.lastAgentMessage}</p>
        </section>
      ) : null}
    </div>
  )
}

function AgentChatComposer({ card }: { card: DashboardCard }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const ptyId = card.ptyId

  if (ptyId === null) {
    return (
      <p className="shrink-0 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        {translate(
          'dashboardPopout.chat.noPane',
          'No live pane, so a reply cannot reach this agent.'
        )}
      </p>
    )
  }

  const send = async (): Promise<void> => {
    const message = draft.trim()
    if (!message || sending) {
      return
    }
    setSending(true)
    setFailed(false)
    try {
      // The framed body and the Enter must be separate pty writes, or the agent
      // TUI treats the submit as part of the pasted text (see native-chat-send).
      const bodySent = await window.api.terminalPreview.input(
        ptyId,
        buildNativeChatPasteBytes(message)
      )
      const submitted =
        bodySent && (await window.api.terminalPreview.input(ptyId, NATIVE_CHAT_SUBMIT))
      if (!submitted) {
        setFailed(true)
        return
      }
      setDraft('')
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          disabled={sending}
          aria-label={translate('dashboardPopout.chat.placeholder', 'Reply to this agent')}
          placeholder={translate('dashboardPopout.chat.placeholder', 'Reply to this agent')}
          className="h-8 text-xs"
        />
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={sending || draft.trim().length === 0}
          onClick={() => void send()}
        >
          {translate('dashboardPopout.chat.send', 'Send')}
        </Button>
      </div>
      {failed ? (
        <p className="mt-1.5 text-[11px] text-destructive">
          {translate(
            'dashboardPopout.chat.sendFailed',
            'The reply did not reach the agent. Open the terminal to check it.'
          )}
        </p>
      ) : null}
    </div>
  )
}

function AgentChatBody({
  card,
  mode
}: {
  card: DashboardCard
  mode: AgentChatPanelMode
}): React.JSX.Element {
  if (mode.kind === 'degraded') {
    return <AgentChatFallback card={card} reason={mode.reason} />
  }
  return (
    <AgentChatTranscript
      key={`${card.paneKey}:${mode.sessionId}`}
      card={card}
      sessionId={mode.sessionId}
      transcriptPath={mode.transcriptPath}
    />
  )
}

/**
 * Respond surface for one agent, beside the fleet view: the agent's real native
 * chat transcript plus a composer that writes to its live pane. Degrades to the
 * snapshot's own last message when the transcript is unreachable from here.
 */
export function AgentChatPanel({
  card,
  onClose,
  onOpenTerminal,
  className
}: AgentChatPanelProps): React.JSX.Element {
  const titleId = useId()
  const mode = resolveAgentChatPanelMode(card)

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'm-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border',
        'bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]',
        className
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <AgentStateDot state={card.dotState} size="md" className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-[12px] leading-normal font-semibold">
            {agentName(card)}
          </h2>
          <span className="block truncate text-[11px] text-muted-foreground">
            {card.repoName} / {card.worktreeName}
          </span>
        </span>
        {onOpenTerminal ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 gap-1.5"
            onClick={onOpenTerminal}
          >
            <SquareTerminal className="size-3.5" />
            {translate('dashboardPopout.chat.openTerminal', 'Open terminal')}
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label={translate('dashboardPopout.chat.close', 'Close chat')}
          className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <AgentChatBody card={card} mode={mode} />
      <AgentChatComposer card={card} />
    </section>
  )
}
