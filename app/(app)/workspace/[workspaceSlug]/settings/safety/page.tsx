import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { SafetySettingsView } from '@/components/settings/safety-settings'
import { getSafetySettings } from './actions'

export default async function SafetySettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const settings = await getSafetySettings(typeof query.profile === 'string' ? query.profile : '')
  return <SafetySettingsView workspaceSlug={workspaceSlug} settings={settings} />
}
