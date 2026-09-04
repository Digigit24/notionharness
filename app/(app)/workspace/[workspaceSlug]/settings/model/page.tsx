import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { ModelSettingsView } from '@/components/settings/model-settings'
import { getModelSettings } from './actions'

export default async function ModelSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  // '' is the install root, which is a real choice rather than "unset".
  const profile = typeof query.profile === 'string' ? query.profile : ''
  const settings = await getModelSettings(profile)

  return <ModelSettingsView workspaceSlug={workspaceSlug} settings={settings} />
}
