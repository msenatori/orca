import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentChatPanel } from './AgentChatPanel'

type AgentNativeChatDrawerProps = {
  card: DashboardCard
  onClose: () => void
  onOpenTerminal: () => void
}

/** Dashboard-native chat lives in a window-edge drawer, independent of map layout. */
export function AgentNativeChatDrawer({
  card,
  onClose,
  onOpenTerminal
}: AgentNativeChatDrawerProps): React.JSX.Element {
  return (
    <Sheet modal={false} open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="left"
        showCloseButton={false}
        overlayClassName="hidden"
        aria-describedby={undefined}
        className="w-[min(42rem,calc(100vw-3rem))] p-0 sm:max-w-none"
      >
        <SheetTitle className="sr-only">
          {translate('dashboardPopout.chat.drawerTitle', 'Native chat')}
        </SheetTitle>
        <AgentChatPanel
          card={card}
          onClose={onClose}
          onOpenTerminal={onOpenTerminal}
          className="m-0 h-full rounded-none border-0 shadow-none"
        />
      </SheetContent>
    </Sheet>
  )
}
