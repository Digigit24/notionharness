import type { ReactNode } from 'react'
import { SettingsRail } from '@/components/settings/settings-rail'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'

/**
 * The settings shell: one persistent rail, one swapping panel.
 *
 * Every section under `/settings` is a real child route, so this layout stays
 * mounted across them — clicking Providers after Skills re-renders only the
 * panel, which is what makes the rail behave like tabs rather than like a
 * menu of separate pages. It also means each section keeps its own URL and
 * its own server-side data loading, instead of one page fetching everything
 * for every tab.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params

  // Hermes-specific screens are hidden when no Hermes runtime is enabled here.
  // A count, not a fetch of the rows: the rail only needs to know whether one
  // exists (D0).
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  let hasHermesRuntime = false
  if (workspace) {
    const payload = await getPayloadClient()
    const found = await payload.count({
      collection: 'runtime-profiles',
      where: {
        and: [
          { workspace: { equals: workspace.id } },
          { enabled: { equals: true } },
          // A profile predating `homeStrategy` has no value and is Hermes by
          // history, so absence counts as Hermes rather than hiding screens
          // someone is already using.
          { or: [{ homeStrategy: { equals: 'hermes' } }, { homeStrategy: { exists: false } }] },
        ],
      },
      overrideAccess: true,
    })
    hasHermesRuntime = found.totalDocs > 0
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsRail workspaceSlug={workspaceSlug} hasHermesRuntime={hasHermesRuntime} />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
