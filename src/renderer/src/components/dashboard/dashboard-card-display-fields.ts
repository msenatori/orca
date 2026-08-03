import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { DashboardAgentRow } from './useDashboardData'

export function dashboardCardTask(row: DashboardAgentRow): string {
  return (row.entry.orchestration?.taskTitle ?? '').trim() || (row.entry.prompt ?? '').trim()
}

export function nonEmptyDashboardCardText(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function boundedDashboardCardLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

export function boundedDashboardCardLabelOrUndefined(
  value: string | undefined
): string | undefined {
  return value === undefined ? undefined : boundedDashboardCardLabel(value)
}

/** Mirrors the sidebar while avoiding a parent tab's name on an inline child row. */
export function dashboardCardConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): string | undefined {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  if (
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  ) {
    return undefined
  }
  return getAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled) ?? undefined
}
