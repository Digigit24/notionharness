import { PluginsSettings } from '@/components/settings/plugins-settings'
import { listAgentOptions, listPlugins } from './actions'

export const metadata = {
  title: 'Plugins | NotionForge',
}

/**
 * R4.1 — the plugin registry, made visible.
 *
 * Both reads are independent and both are small, so they go out together
 * rather than one after the other (D0: no sequential awaits in a server
 * component that could be one `Promise.all`).
 */
export default async function PluginsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const [plugins, agents] = await Promise.all([listPlugins(workspaceSlug), listAgentOptions(workspaceSlug)])
  // The URL an agent would actually reach this app on. Read from the
  // environment rather than guessed from the request, because a run may be
  // executing on a different machine than the browser rendering this page.
  const appUrl = (process.env.NOTIONFORGE_URL || 'http://localhost:3000').replace(/\/$/, '')

  return <PluginsSettings workspaceSlug={workspaceSlug} plugins={plugins} agents={agents} appUrl={appUrl} />
}
