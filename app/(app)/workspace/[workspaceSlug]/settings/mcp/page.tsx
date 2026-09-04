import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { McpSettingsView } from '@/components/settings/mcp-settings'
import { getMcpSettings } from './actions'

export default async function McpSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const settings = await getMcpSettings(typeof query.profile === 'string' ? query.profile : '')
  return <McpSettingsView workspaceSlug={workspaceSlug} settings={settings} />
}
