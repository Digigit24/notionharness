import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { getActiveModelConfig, listKnownProviders, listProviderEnvSlots, listProviderKeyStatus } from '@/lib/hermes/providers'
import { listHermesProfiles } from '@/lib/hermes/profiles'
import { ProvidersView } from '@/components/providers/providers-view'

export default async function ProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  // Which profile this page is editing lives in the URL, not in component
  // state, so a particular profile's settings are linkable and survive a
  // reload — and so the server can read that profile's own files directly.
  const { profile: profileParam } = await searchParams
  const profiles = await listHermesProfiles()
  const selectedProfile = profiles.some((entry) => entry.name === (profileParam ?? ''))
    ? (profileParam ?? '')
    : ''

  const [active, providers, envSlots] = await Promise.all([
    getActiveModelConfig(selectedProfile || null),
    listKnownProviders(selectedProfile || null),
    listProviderEnvSlots(),
  ])
  const keyStatus = await listProviderKeyStatus(providers.map((p) => p.provider))

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[
            { label: workspace.name, href: `/workspace/${workspace.slug}` },
            { label: 'Settings', href: `/workspace/${workspace.slug}/settings` },
            { label: 'Providers' },
          ]}
        />
        <h1 className="text-2xl font-semibold">Providers</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Which AI provider and model each Hermes profile uses — real, live config from this machine. Every profile
          is its own complete Hermes home, so an agent pinned to a profile answers with that profile&apos;s model
          and credentials.
        </p>
      </div>

      <ProvidersView
        workspaceSlug={workspace.slug}
        profiles={profiles}
        selectedProfile={selectedProfile}
        active={active}
        providers={providers}
        keyStatus={keyStatus}
        envSlots={envSlots}
      />
    </main>
  )
}
