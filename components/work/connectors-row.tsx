import Link from 'next/link'
import { ArrowRight, GitBranch, Mail, MessageSquare, NotebookText } from 'lucide-react'

/**
 * The hero composer's "Connect your integrations" strip.
 *
 * Deliberately NOT `getConnectorPanel` (`settings/connectors/actions.ts`) —
 * that is three queries (`listConnectorsForSurface`, `listViewerConnections`,
 * `describeKey`) meant for a page whose whole job is showing connector state.
 * Work's blank state is exactly the render D0 calls out ("a change that adds
 * a query... states its cost") — paying for three extra queries so a brand
 * new chat can show which toolkits are ALREADY connected is not a cost this
 * page should carry for a strip whose only real job is pointing at Settings.
 * A small static list of well-known toolkits, with no round trip, says the
 * same thing ("you can connect tools") without it.
 *
 * `components/connectors/connectors-panel.tsx` and everything under
 * `settings/connectors/` are a sibling unit of work's files — this component
 * imports nothing from either and does not attempt to reproduce their icon
 * set (`toolkit-picker.tsx`'s own `ToolkitOption.iconUrl` comes from
 * Composio's live catalogue, not a local icon this page could import).
 */
// Generic lucide glyphs, not brand marks — lucide-react dropped its brand
// icon set (Github, Slack, etc.) some releases ago, and this row has no
// license to draw a trademarked logo itself. Good enough to say "these kinds
// of tools connect here"; the real logos live in Composio's own catalogue,
// shown by `toolkit-picker.tsx` on the actual Settings page.
const TOOLKITS = [
  { icon: Mail, label: 'Gmail' },
  { icon: MessageSquare, label: 'Slack' },
  { icon: GitBranch, label: 'GitHub' },
  { icon: NotebookText, label: 'Notion' },
] as const

export function ConnectorsRow({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
      <div className="flex items-center gap-1.5">
        {TOOLKITS.map(({ icon: Icon, label }) => (
          <span
            key={label}
            title={label}
            className="flex size-6 items-center justify-center rounded-full border border-black/10 bg-black/[.02] text-black/45 dark:border-white/15 dark:bg-white/[.04] dark:text-white/45"
          >
            <Icon size={12} />
          </span>
        ))}
      </div>
      <Link
        href={`/workspace/${workspaceSlug}/settings/connectors`}
        className="flex shrink-0 items-center gap-1 text-xs font-medium text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
      >
        Connect your integrations
        <ArrowRight size={12} />
      </Link>
    </div>
  )
}
