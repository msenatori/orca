// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentChatPanel } from './AgentChatPanel'

// The real transcript list drives markdown, autoscroll, and IPC reads; the panel
// contract under test is what it feeds them, so both are stubbed.
const liveSession = vi.hoisted(() => vi.fn())
vi.mock('@/components/native-chat/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: (args: unknown) => liveSession(args)
}))
vi.mock('@/components/native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: ({
    session,
    isWorking
  }: {
    session: { messages: { id: string }[] }
    isWorking: boolean
  }) => (
    <div
      data-testid="native-chat-list"
      data-working={isWorking}
      data-messages={session.messages.length}
    />
  )
}))

const terminalInput = vi.fn(async () => true)

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Ship the chat panel',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'chat-panel',
    conversationName: 'Chat agent',
    hostKind: 'local',
    sessionId: 'session-1',
    transcriptPath: '/tmp/session-1.jsonl',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    ...overrides
  }
}

beforeEach(() => {
  liveSession.mockReturnValue({
    agent: 'claude',
    sessionId: 'session-1',
    messages: [{ id: 'm1', role: 'assistant' }],
    status: 'idle',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  })
  ;(window as unknown as { api: unknown }).api = { terminalPreview: { input: terminalInput } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentChatPanel', () => {
  it('reads the real transcript for the card session and heads it with the agent', () => {
    render(<AgentChatPanel card={card()} onClose={vi.fn()} />)

    expect(liveSession).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/tmp/session-1.jsonl',
      runtimeEnvironmentId: null
    })
    expect(screen.getByTestId('native-chat-list')).toHaveAttribute('data-messages', '1')
    // The pop-out has no live store, so the snapshot bucket is the working signal.
    expect(screen.getByTestId('native-chat-list')).toHaveAttribute('data-working', 'true')
    expect(screen.getByRole('heading', { name: 'Chat agent' })).toBeInTheDocument()
    expect(screen.getByText('Orca / chat-panel')).toBeInTheDocument()
  })

  it('sends the body and the submit as separate pty writes', async () => {
    render(<AgentChatPanel card={card()} onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Reply to this agent'), {
      target: { value: 'ship it' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(terminalInput).toHaveBeenCalledTimes(2))
    expect(terminalInput).toHaveBeenNthCalledWith(1, 'pty-1', 'ship it')
    expect(terminalInput).toHaveBeenNthCalledWith(2, 'pty-1', '\r')
    await waitFor(() => expect(screen.getByLabelText('Reply to this agent')).toHaveValue(''))
  })

  it('reports a refused write instead of pretending the reply landed', async () => {
    terminalInput.mockResolvedValueOnce(false)
    render(<AgentChatPanel card={card()} onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Reply to this agent'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/did not reach the agent/)).toBeInTheDocument()
    expect(terminalInput).toHaveBeenCalledTimes(1)
    // The draft survives so the user can retry or copy it out.
    expect(screen.getByLabelText('Reply to this agent')).toHaveValue('hello')
  })

  it('withholds the composer when the agent has no live pane', () => {
    render(<AgentChatPanel card={card({ ptyId: null })} onClose={vi.fn()} />)

    expect(
      screen.getByText('No live pane, so a reply cannot reach this agent.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  })

  it('degrades to the snapshot text when the card has no session', () => {
    render(
      <AgentChatPanel
        card={card({
          sessionId: undefined,
          transcriptPath: undefined,
          bucket: 'attention',
          dotState: 'waiting',
          askSummary: 'Approve the migration?',
          lastAgentMessage: 'I paused before the migration.'
        })}
        onClose={vi.fn()}
      />
    )

    expect(liveSession).not.toHaveBeenCalled()
    expect(screen.queryByTestId('native-chat-list')).not.toBeInTheDocument()
    expect(screen.getByText(/has not reported a session yet/)).toBeInTheDocument()
    expect(screen.getByText('Approve the migration?')).toBeInTheDocument()
    expect(screen.getByText('I paused before the migration.')).toBeInTheDocument()
    // Replying still works — only the transcript read is unavailable.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('degrades on a remote host, whose transcript path is not local', () => {
    render(<AgentChatPanel card={card({ hostKind: 'ssh' })} onClose={vi.fn()} />)

    expect(liveSession).not.toHaveBeenCalled()
    expect(screen.getByText(/runs on a remote host/)).toBeInTheDocument()
  })

  it('escalates to the terminal and closes on request', () => {
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn()
    render(<AgentChatPanel card={card()} onClose={onClose} onOpenTerminal={onOpenTerminal} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
