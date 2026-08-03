// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardFilterOptions,
  DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanBoard } from './AgentKanbanBoard'

// Stub the card and dialog so the board test stays free of xterm / Radix
// machinery while still exercising the board-owned dialog wiring.
vi.mock('./AgentKanbanCard', () => ({
  AgentKanbanCard: ({
    card,
    repoIcon,
    now,
    onOpenTerminal
  }: {
    card: DashboardCard
    repoIcon?: RepoIcon | null
    now: number
    onOpenTerminal: (card: DashboardCard) => void
  }) => (
    <div
      data-testid="card"
      data-bucket={card.bucket}
      data-unseen={card.unseen}
      data-now={now}
      data-repo-icon={repoIcon === null ? 'none' : JSON.stringify(repoIcon)}
      onClick={() => onOpenTerminal(card)}
    >
      {card.worktreeName}
    </div>
  )
}))
vi.mock('./AgentTerminalDialog', () => ({
  AgentTerminalDialog: ({
    card,
    onOpenChange,
    reviewed,
    pinned,
    onMarkReviewed,
    onTogglePinned
  }: {
    card: DashboardCard | null
    onOpenChange: (open: boolean) => void
    reviewed?: boolean
    pinned?: boolean
    onMarkReviewed?: (card: DashboardCard) => void
    onTogglePinned?: (card: DashboardCard) => void
  }) => (
    <div
      data-testid="terminal-dialog"
      data-open={card !== null}
      data-bucket={card?.bucket}
      data-pty-id={card?.ptyId ?? undefined}
      data-reviewed={reviewed}
      data-pinned={pinned}
    >
      <button data-testid="terminal-dialog-close" onClick={() => onOpenChange(false)} />
      {card && onMarkReviewed ? (
        <button data-testid="terminal-dialog-review" onClick={() => onMarkReviewed(card)} />
      ) : null}
      {card && onTogglePinned ? (
        <button data-testid="terminal-dialog-pin" onClick={() => onTogglePinned(card)} />
      ) : null}
    </div>
  ),
  AgentTerminalPanel: ({
    card,
    onOpenChange,
    reviewed,
    pinned,
    onMarkReviewed,
    onTogglePinned
  }: {
    card: DashboardCard | null
    onOpenChange: (open: boolean) => void
    reviewed?: boolean
    pinned?: boolean
    onMarkReviewed?: (card: DashboardCard) => void
    onTogglePinned?: (card: DashboardCard) => void
  }) => (
    <div
      data-testid="terminal-panel"
      data-pty-id={card?.ptyId ?? undefined}
      data-reviewed={reviewed}
      data-pinned={pinned}
    >
      <button data-testid="terminal-panel-close" onClick={() => onOpenChange(false)} />
      {card && onMarkReviewed ? (
        <button
          data-testid="terminal-panel-review"
          onClick={() => {
            onMarkReviewed(card)
            if (!pinned) {
              onOpenChange(false)
            }
          }}
        />
      ) : null}
      {card && onTogglePinned ? (
        <button data-testid="terminal-panel-pin" onClick={() => onTogglePinned(card)} />
      ) : null}
    </div>
  )
}))
vi.mock('./AgentChatPanel', () => ({
  AgentChatPanel: ({
    card,
    onClose,
    onOpenTerminal,
    className
  }: {
    card: DashboardCard
    onClose: () => void
    onOpenTerminal?: () => void
    className?: string
  }) => (
    <div data-testid="chat-panel" data-pane-key={card.paneKey} className={className}>
      <button data-testid="chat-panel-close" onClick={onClose} />
      <button data-testid="chat-panel-terminal" onClick={onOpenTerminal} />
    </div>
  )
}))

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: Math.random().toString(36),
    ptyId: 'p1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 't',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: 'l1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

function renderBoard(
  cards: DashboardCard[],
  options: {
    showIdle?: boolean
    repoIconsByRepoId?: Record<string, RepoIcon | null>
    filterOptions?: DashboardFilterOptions
  } = {}
): void {
  const snapshot: DashboardSnapshot = { generatedAt: 1, cards, ...options }
  render(<AgentKanbanBoard snapshot={snapshot} />)
}

const ackAgent = vi.fn(async () => {})

describe('AgentKanbanBoard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    localStorage.clear()
    // The board relays seen-acks through the dashboard preload API.
    ;(window as unknown as { api: unknown }).api = { dashboard: { ackAgent } }
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('renders the three default columns in order', () => {
    renderBoard([])
    const headers = screen.getAllByText(/Needs You|Working|Done/)
    expect(headers.map((h) => h.textContent)).toEqual(['Needs You', 'Working', 'Done'])
  })

  it('keeps the dashboard and map available as separate views', () => {
    renderBoard([])

    fireEvent.click(screen.getByRole('button', { name: 'Agent Map' }))
    expect(screen.getByText('Live containment map')).toBeInTheDocument()
    expect(screen.getByText('Focus view')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }))
    expect(screen.getByText('Needs You')).toBeInTheDocument()
  })

  it('keeps the selected map visible beside its terminal panel', () => {
    const agent = card({ paneKey: 'map-agent', conversationName: 'Map agent' })
    render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} initialView="map" />)

    fireEvent.click(screen.getByRole('button', { name: /Map agent/ }))

    expect(screen.getByLabelText('Nested project, workspace, and agent map')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-pty-id', 'p1')
    expect(screen.getByRole('button', { name: /Map agent/ })).toHaveClass('is-selected')
    expect(screen.queryByText('Focus view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-dialog')).not.toBeInTheDocument()
  })

  it('opens native chat on the map-selected side and can switch to terminal preview', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(800, 0, 100, 100)
    )
    const agent = card({
      paneKey: 'native-map-agent',
      conversationName: 'Native map agent',
      viewMode: 'chat'
    })
    render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} initialView="map" />)

    fireEvent.click(screen.getByRole('button', { name: /Native map agent/ }))

    const chatPanel = screen.getByTestId('chat-panel')
    expect(chatPanel).toHaveClass('mr-0', 'slide-in-from-left-2')
    expect(chatPanel.parentElement).toHaveClass('flex-row-reverse')
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('chat-panel-terminal'))
    expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-pty-id', 'p1')
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument()
  })

  it('switches an open map inspector when the live tab enters native chat', () => {
    const terminalAgent = card({ paneKey: 'switching-agent', conversationName: 'Switching agent' })
    const { rerender } = render(
      <AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [terminalAgent] }} initialView="map" />
    )
    fireEvent.click(screen.getByRole('button', { name: /Switching agent/ }))
    expect(screen.getByTestId('terminal-panel')).toBeInTheDocument()

    rerender(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 2, cards: [{ ...terminalAgent, viewMode: 'chat' }] }}
        initialView="map"
      />
    )

    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-pane-key', 'switching-agent')
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
  })

  it('focuses search with Ctrl+K without taking focus from response fields', () => {
    renderBoard([])
    const search = screen.getByLabelText('Search agents')

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(search).toHaveFocus()

    const response = document.createElement('textarea')
    document.body.append(response)
    response.focus()
    fireEvent.keyDown(response, { key: 'k', ctrlKey: true })
    expect(response).toHaveFocus()
    response.remove()
  })

  it('places cards in their bucket column and counts them', () => {
    renderBoard([
      card({ bucket: 'attention', worktreeName: 'a1' }),
      card({ bucket: 'attention', worktreeName: 'a2' }),
      card({ bucket: 'done', worktreeName: 'd1' })
    ])
    const cards = screen.getAllByTestId('card')
    expect(cards).toHaveLength(3)
    expect(cards.filter((c) => c.dataset.bucket === 'attention')).toHaveLength(2)
    expect(within(document.body).getByText('d1').dataset.bucket).toBe('done')
    expect(screen.getByText('3 total')).toBeTruthy()
  })

  it('leaves every column border neutral now that cards carry the state color', () => {
    renderBoard([card({ bucket: 'attention' })])
    for (const column of document.querySelectorAll('section')) {
      expect(column.className).toContain('border-border/60')
      expect(column.className).not.toContain('amber')
    }
  })

  it('routes each card its own repo icon', () => {
    renderBoard(
      [
        card({ repoId: 'r1', worktreeName: 'from-r1' }),
        card({ repoId: 'r2', worktreeName: 'from-r2' }),
        card({ repoId: 'r3', worktreeName: 'from-r3' })
      ],
      { repoIconsByRepoId: { r1: { type: 'lucide', name: 'Rocket' }, r2: null } }
    )

    expect(screen.getByText('from-r1').dataset.repoIcon).toBe('{"type":"lucide","name":"Rocket"}')
    expect(screen.getByText('from-r2').dataset.repoIcon).toBe('none')
    // Unknown repo → the card's own default glyph, never another repo's icon.
    expect(screen.getByText('from-r3').dataset.repoIcon).toBe('none')
  })

  it('shows "None" for empty columns', () => {
    renderBoard([card({ bucket: 'working' })])
    // attention and done are empty → two "None" placeholders.
    expect(screen.getAllByText('None')).toHaveLength(2)
  })

  it('shows the idle column only when enabled', () => {
    renderBoard([card({ bucket: 'idle', worktreeName: 'quiet-agent' })], { showIdle: true })

    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.getByText('quiet-agent')).toBeInTheDocument()
  })

  it('searches agent content and reports the visible result count', () => {
    renderBoard([
      card({ worktreeName: 'first', task: 'repair relay authentication' }),
      card({ worktreeName: 'second', task: 'update dashboard layout' })
    ])

    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'relay' } })

    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.queryByText('second')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 shown')).toBeInTheDocument()
  })

  it('localizes the new board status and filter controls', async () => {
    await i18n.changeLanguage('ja')
    renderBoard([card({ bucket: 'done' })])

    expect(screen.getByText('完了')).toBeInTheDocument()
    expect(screen.getByLabelText('エージェントを検索')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^フィルター/ })).toBeInTheDocument()
  })

  it('offers store-derived project and status filters without cards', async () => {
    renderBoard([], {
      filterOptions: {
        projects: [{ id: 'r1', label: 'Repo One' }],
        workspaceStatuses: [{ id: 'planned', label: 'Planned', color: 'neutral' }]
      }
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Filter/ }))

    expect(await screen.findByText('Repo One')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('PR / MR status')).toBeInTheDocument()
  })

  it('orders cards in a column by most recent bucket entry first', () => {
    renderBoard([
      card({ bucket: 'working', worktreeName: 'old-move', stateChangedAt: 1000 }),
      card({ bucket: 'working', worktreeName: 'new-move', stateChangedAt: 3000 }),
      card({ bucket: 'working', worktreeName: 'mid-move', stateChangedAt: 2000 })
    ])
    const names = screen.getAllByTestId('card').map((c) => c.textContent)
    expect(names).toEqual(['new-move', 'mid-move', 'old-move'])
  })

  it('does not start the clock when no card renders a relative timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)

    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [] }} />)
    expect(vi.getTimerCount()).toBe(0)

    rerender(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 2, cards: [card({ startedAt: 0, finishedAt: null })] }}
      />
    )
    const initialNow = screen.getByTestId('card').dataset.now

    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('card').dataset.now).toBe(initialNow)
  })

  it('parks the clock while hidden, catches up on reveal, and ticks while visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    let visibilityState: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)

    renderBoard([card({ startedAt: 1 })])
    expect(screen.getByTestId('card').dataset.now).toBe('100000')
    expect(vi.getTimerCount()).toBe(0)

    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByTestId('card').dataset.now).toBe('100000')

    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(screen.getByTestId('card').dataset.now).toBe('160000')
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('card').dataset.now).toBe('190000')
  })

  it('keeps the terminal dialog open across bucket moves and card removal', () => {
    const agent = card({ paneKey: 'pk-1', bucket: 'done', worktreeName: 'wt1' })
    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('false')

    fireEvent.click(screen.getByTestId('card'))
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')

    // Sending a message flips the agent done → working; the dialog must
    // follow the card to its new bucket instead of closing.
    const moved = { ...agent, bucket: 'working' as const, dotState: 'working' as const }
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 2, cards: [moved] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.bucket).toBe('working')

    // Even a vanished card (pane closed) keeps the dialog up — the user
    // dismisses it explicitly, but stale live routing is cleared.
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 3, cards: [] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.ptyId).toBeUndefined()
  })

  it('relays a seen-ack when a dialog opens and when the open agent changes state', () => {
    const agent = card({ paneKey: 'pk-ack', bucket: 'done', unseen: true })
    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} />)
    // unseen comes straight from the snapshot (the shared ack map).
    expect(screen.getByTestId('card').dataset.unseen).toBe('true')

    fireEvent.click(screen.getByTestId('card'))
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
    ackAgent.mockClear()

    // The ack round-trips through the main window; the next snapshot mutes it.
    rerender(
      <AgentKanbanBoard snapshot={{ generatedAt: 2, cards: [{ ...agent, unseen: false }] }} />
    )
    expect(screen.getByTestId('card').dataset.unseen).toBe('false')
    expect(ackAgent).not.toHaveBeenCalled()

    // A state change while the dialog is open re-acks (watching counts as
    // seeing), so the card never flips bold under an open dialog.
    rerender(
      <AgentKanbanBoard
        snapshot={{
          generatedAt: 3,
          cards: [{ ...agent, bucket: 'working' as const, stateChangedAt: 2000, unseen: true }]
        }}
      />
    )
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
  })

  it('keeps a newly opened result in Focus until it is explicitly reviewed', () => {
    const fresh = card({
      paneKey: 'fresh-result',
      bucket: 'done',
      dotState: 'done',
      conversationName: 'Fresh result',
      finishedAt: 900,
      unseen: true
    })
    const old = card({
      paneKey: 'old-result',
      bucket: 'done',
      dotState: 'done',
      conversationName: 'Old result',
      finishedAt: 800,
      unseen: false
    })
    const view = render(
      <AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [fresh, old] }} initialView="map" />
    )

    expect(screen.getByRole('button', { name: /Fresh result/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Old result/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fresh result/ }))
    expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-reviewed', 'false')

    view.rerender(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 2, cards: [{ ...fresh, unseen: false }, old] }}
        initialView="map"
      />
    )
    expect(screen.getByRole('button', { name: /Fresh result/ })).toBeInTheDocument()

    view.unmount()
    const reopened = render(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 3, cards: [{ ...fresh, unseen: false }, old] }}
        initialView="map"
      />
    )
    expect(screen.getByRole('button', { name: /Fresh result/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fresh result/ }))
    fireEvent.click(screen.getByTestId('terminal-panel-review'))
    expect(screen.queryByRole('button', { name: /Fresh result/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()

    reopened.unmount()
    render(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 4, cards: [{ ...fresh, unseen: false }, old] }}
        initialView="map"
      />
    )
    expect(screen.queryByRole('button', { name: /Fresh result/ })).not.toBeInTheDocument()
  })
})
