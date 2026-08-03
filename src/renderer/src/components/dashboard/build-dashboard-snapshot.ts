import type { AppState } from '@/store/types'
import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardDotState,
  DashboardCardSubagent,
  DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveDashboardCardTerminalInput,
  type DashboardCardTerminalInputState
} from './dashboard-card-terminal-input'
import { readDashboardClientHost } from './dashboard-client-host'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { applyAgentRowLineage, dashboardCardParentPaneKey } from './agent-row-lineage'
import { lastEnteredDoneAt } from './agent-finished-timestamp'
import type { DashboardAgentRow } from './useDashboardData'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import {
  EMPTY_WORKTREE_AGENT_ORCHESTRATION,
  releaseRuntimeAgentOrchestrationBatchCache,
  selectRuntimeAgentOrchestrationBatch
} from '../sidebar/worktree-agent-orchestration-batch'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'
import {
  resolveDashboardCardContext,
  type DashboardCardContextState
} from './dashboard-card-context'
import {
  collectActiveDashboardWorkspaces,
  dashboardCardHostKind
} from './dashboard-snapshot-workspaces'
import {
  boundedDashboardCardLabel,
  boundedDashboardCardLabelOrUndefined,
  dashboardCardConversationName,
  dashboardCardTask,
  nonEmptyDashboardCardText
} from './dashboard-card-display-fields'
import { dashboardNativeChatTabIds } from './dashboard-native-chat-tab-ids'

/** Store slices needed to build a snapshot without constructing the full AppState in tests. */
export type DashboardSnapshotState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'acknowledgedAgentsByPaneKey'
  | 'settings'
> &
  DashboardCardContextState &
  Partial<DashboardCardTerminalInputState> &
  Partial<Pick<AppState, 'unifiedTabsByWorktree'>>

function bucketForState(state: DashboardAgentRow['state']): DashboardBucket {
  switch (state) {
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    // blocked | waiting — the agent needs the user.
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/**
 * Derive the serializable dashboard snapshot from the live renderer store.
 * Reuses the exact per-worktree row machinery the sidebar uses
 * (buildWorktreeAgentRows + the indexed selectors), then flattens every
 * worktree's rows into presentational cards. Provider subagents without their
 * own terminal stay folded into their spawning card.
 */
export function buildDashboardSnapshot(
  state: DashboardSnapshotState,
  now: number,
  options: { includeCardDetails?: boolean; includeFilterOptions?: boolean } = {}
): DashboardSnapshot {
  const cards: DashboardCard[] = []
  const clientHost = readDashboardClientHost()
  const repoIconsByRepoId: Record<string, RepoIcon | null> = {}
  const includeCardDetails = options.includeCardDetails !== false
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const activeWorktrees = collectActiveDashboardWorkspaces(state)
  const filterOptions =
    options.includeFilterOptions === false
      ? undefined
      : {
          // Why: filterOptions is snapshot-level, so an over-long project label
          // costs the WHOLE board, not one card. Bound it at the producer.
          projects: [
            ...new Map(
              activeWorktrees.map((workspace) => [workspace.projectId, workspace])
            ).values()
          ].map((workspace) => ({
            id: workspace.projectId,
            label: boundedDashboardCardLabel(workspace.projectName)
          })),
          workspaceStatuses: (state.workspaceStatuses && state.workspaceStatuses.length > 0
            ? state.workspaceStatuses
            : DEFAULT_WORKSPACE_STATUSES
          ).map((status) => ({
            id: status.id,
            label: status.label,
            color: status.color
          }))
        }
  let singletonOrchestration: ReturnType<typeof selectRuntimeAgentOrchestrationForWorktree> | null =
    null
  let orchestrationByWorktree: ReturnType<typeof selectRuntimeAgentOrchestrationBatch> | null = null
  if (activeWorktrees.length >= 2) {
    orchestrationByWorktree = selectRuntimeAgentOrchestrationBatch(
      state,
      activeWorktrees.map(({ worktree }) => worktree.id)
    )
  } else {
    releaseRuntimeAgentOrchestrationBatchCache()
    if (activeWorktrees.length === 1) {
      singletonOrchestration = selectRuntimeAgentOrchestrationForWorktree(
        state,
        activeWorktrees[0].worktree.id
      )
    }
  }

  for (const workspace of activeWorktrees) {
    const { repo, worktree } = workspace
    const worktreeId = worktree.id
    const nativeChatTabIds = dashboardNativeChatTabIds(state, worktreeId)
    const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
    const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
    const entries =
      migrationUnsupported.length > 0
        ? [
            ...liveEntries,
            ...migrationUnsupported.flatMap((unsupported) => {
              const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
              return entry ? [entry] : []
            })
          ]
        : liveEntries
    const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)

    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: state.tabsByWorktree[worktreeId] ?? [],
        entries,
        retained: selectRetainedAgentEntriesForWorktree(state, worktreeId),
        runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, worktreeId),
        ptyIdsByTabId: selectLivePtyIdsForWorktree(state, worktreeId),
        terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey:
          singletonOrchestration ??
          orchestrationByWorktree?.get(worktreeId) ??
          EMPTY_WORKTREE_AGENT_ORCHESTRATION,
        now
      })
    )
    const subagentsByParentPaneKey = includeCardDetails
      ? new Map<string, DashboardCardSubagent[]>()
      : undefined
    if (subagentsByParentPaneKey) {
      for (const row of rows) {
        if (row.rowSource !== 'subagent') {
          continue
        }
        const parentPaneKey = row.entry.orchestration?.parentPaneKey
        if (!parentPaneKey) {
          continue
        }
        const subagent: DashboardCardSubagent = {
          id: row.paneKey,
          name:
            nonEmptyDashboardCardText(row.entry.orchestration?.displayName) ??
            nonEmptyDashboardCardText(row.entry.prompt) ??
            row.agentType,
          dotState: row.state
        }
        const existing = subagentsByParentPaneKey.get(parentPaneKey)
        if (existing) {
          existing.push(subagent)
        } else {
          subagentsByParentPaneKey.set(parentPaneKey, [subagent])
        }
      }
    }
    const context = includeCardDetails
      ? resolveDashboardCardContext(state, repo, worktree)
      : undefined

    for (const row of rows) {
      // Child rows have no pane of their own; the board lists top-level agents.
      if (row.rowSource === 'subagent') {
        continue
      }
      // Status-only title rows do not carry real conversation content.
      const isTitleDerived = row.startedAt === 0
      const routingPaneKey = row.activationPaneKey ?? row.paneKey
      const parsed = parsePaneKey(routingPaneKey)
      const tabId = parsed?.tabId ?? row.tab.id
      const leafId = parsed?.leafId ?? null
      const layoutPtyId =
        (leafId ? terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] : undefined) ?? null
      // Layout entries survive app restarts, but their PTYs may not (parked
      // tabs keep the pre-restart id). Only advertise a pty the terminal
      // preview can actually serialize — ptyIdsByTabId is the liveness truth.
      const ptyId =
        layoutPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(layoutPtyId)
          ? layoutPtyId
          : null
      const dotState = row.state as DashboardCardDotState
      const bucket = bucketForState(row.state)
      // Sidebar bucket counts skip host resolution because they cannot open previews.
      const terminalInput =
        ptyId && includeCardDetails
          ? resolveDashboardCardTerminalInput(state, {
              ptyId,
              worktreeId,
              paneKey: routingPaneKey,
              cwd: row.tab.startupCwd ?? worktree.path,
              shellOverride: row.tab.shellOverride,
              launchAgent: row.tab.launchAgent,
              clientPlatform: clientHost.platform,
              userAgent: clientHost.userAgent,
              osRelease: clientHost.osRelease
            })
          : null
      // Only repos that actually contribute a card ship their icon.
      repoIconsByRepoId[workspace.projectId] = workspace.repoIcon

      cards.push({
        paneKey: row.paneKey,
        ptyId,
        agentType: row.agentType,
        bucket,
        dotState,
        task: isTitleDerived ? '' : dashboardCardTask(row),
        repoId: workspace.projectId,
        worktreeId,
        tabId,
        leafId,
        parentPaneKey: dashboardCardParentPaneKey(row),
        repoName: boundedDashboardCardLabel(workspace.projectName),
        worktreeName: boundedDashboardCardLabel(worktree.displayName),
        hostKind: dashboardCardHostKind(
          workspace,
          ptyId,
          terminalInput ?? undefined,
          clientHost.platform
        ),
        workspaceKind: workspace.workspaceKind,
        viewMode: nativeChatTabIds.has(tabId) ? 'chat' : 'terminal',
        workspaceStatusId: context?.workspaceStatus.id,
        workspaceStatusLabel: context?.workspaceStatus.label,
        workspaceStatusColor: context?.workspaceStatus.color,
        hasReview: context ? context.hasReview || context.review !== undefined : undefined,
        review: context?.review,
        subagents: subagentsByParentPaneKey?.get(row.paneKey),
        lastUserMessage: isTitleDerived ? undefined : nonEmptyDashboardCardText(row.entry.prompt),
        lastAgentMessage: isTitleDerived
          ? undefined
          : nonEmptyDashboardCardText(row.entry.lastAssistantMessage),
        startedAt: row.startedAt,
        finishedAt: lastEnteredDoneAt(row),
        stateChangedAt: row.entry.stateStartedAt || row.startedAt,
        // Same derivation as WorktreeCardAgents' unvisitedByPaneKey, so the
        // board and the sidebar bold/mute the same agents at the same time.
        unseen:
          !isTitleDerived &&
          (state.acknowledgedAgentsByPaneKey?.[row.paneKey] ?? 0) < row.entry.stateStartedAt,
        askSummary: bucket === 'attention' ? (row.entry.interactivePrompt ?? undefined) : undefined,
        conversationName: boundedDashboardCardLabelOrUndefined(
          dashboardCardConversationName(row, generatedTitlesEnabled)
        ),
        ...(terminalInput ? { terminalInput } : {}),
        ...(row.entry.providerSession?.id ? { sessionId: row.entry.providerSession.id } : {}),
        ...(row.entry.providerSession?.transcriptPath
          ? { transcriptPath: row.entry.providerSession.transcriptPath }
          : {})
      })
    }
  }

  return {
    generatedAt: now,
    cards,
    showIdle: state.settings?.experimentalAgentDashboardShowIdle === true,
    filterOptions,
    repoIconsByRepoId
  }
}
