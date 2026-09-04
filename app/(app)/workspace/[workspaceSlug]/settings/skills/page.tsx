import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { SkillsSettingsView } from '@/components/settings/skills-settings'
import { getSkillsSettings } from './actions'

export default async function SkillsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const settings = await getSkillsSettings(typeof query.profile === 'string' ? query.profile : '')
  return <SkillsSettingsView workspaceSlug={workspaceSlug} settings={settings} />
}
