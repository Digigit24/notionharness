import type { ReactNode } from 'react'
import { SettingsRail } from '@/components/settings/settings-rail'

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
  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsRail workspaceSlug={workspaceSlug} />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
