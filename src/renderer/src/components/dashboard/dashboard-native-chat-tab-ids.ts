import type { AppState } from '@/store/types'

type DashboardNativeChatState = Pick<AppState, 'settings'> &
  Partial<Pick<AppState, 'unifiedTabsByWorktree'>>

export function dashboardNativeChatTabIds(
  state: DashboardNativeChatState,
  worktreeId: string
): ReadonlySet<string> {
  if (state.settings?.experimentalNativeChat !== true) {
    return new Set()
  }
  return new Set(
    (state.unifiedTabsByWorktree?.[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal' && tab.viewMode === 'chat')
      .map((tab) => tab.entityId)
  )
}
