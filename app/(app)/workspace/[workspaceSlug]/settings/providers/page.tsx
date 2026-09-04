import { notFound } from 'next/navigation'
import Link from 'next/link'

import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getPayloadClient } from '@/lib/payload'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import {
  getActiveModelConfig,
  listKnownProviders,
  listProviderEnvSlots,
  listProviderKeyStatus,
} from '@/lib/runtimes/hermes/providers'
import { listHermesProfiles } from '@/lib/runtimes/hermes/profiles'
import { ProvidersView } from '@/components/providers/providers-view'
import { RuntimeTabs, type RuntimeTab } from '@/components/providers/runtime-tabs'
import { sessionConfigOptions, type AgentHandshake } from '@/lib/runtimes/handshake'

/**
 * Providers, per runtime.
 *
 * This page used to be Hermes and nothing else, which was wrong in a way that
 * got worse the moment a second runtime existed: it read Hermes config off
 * this machine no matter which runtime an agent actually used, and offered no
 * way at all to see what another runtime provides.
 *
 * Now each runtime gets a tab, and the tabs are genuinely different things
 * because the runtimes are:
 *
 * - **Hermes** owns its own providers and credentials in `config.yaml`, one
 *   set per profile. So its tab is the provider/key editor it always was.
 * - **A protocol-native runtime** (Claude Code through its ACP adapter, say)
 *   declares its models to us over ACP, holds its own credentials, and takes
 *   a model per session. So its tab lists what it declared and points at the
 *   agent that will use it. There is nothing to edit here, and pretending
 *   otherwise would invent a settings surface that writes nowhere.
 *
 * The Hermes reads are deliberately inside the Hermes branch. Rendering a
 * Claude tab must not touch a Hermes install (D0).
 */
export default async function ProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ profile?: string; runtime?: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const { profile: profileParam, runtime: runtimeParam } = await searchParams

  const payload = await getPayloadClient()
  const runtimes = await payload.find({
    collection: 'runtime-profiles',
    where: { workspace: { equals: workspace.id }, enabled: { equals: true } },
    sort: 'name',
    limit: 50,
    depth: 0,
    overrideAccess: true,
  })

  const usesHermesHome = (r: { homeStrategy?: string | null }) => (r.homeStrategy ?? 'hermes') === 'hermes'

  const tabs: RuntimeTab[] = runtimes.docs.map((r) => ({
    id: r.id,
    name: r.name,
    hint: usesHermesHome(r) ? 'Profiles, keys and endpoints' : 'Models the runtime declares',
  }))

  const requested = Number(runtimeParam)
  const selectedRuntime =
    runtimes.docs.find((r) => r.id === requested) ??
    // Default to a Hermes runtime when one exists, because that tab is the one
    // with something to edit.
    runtimes.docs.find(usesHermesHome) ??
    runtimes.docs[0] ??
    null

  const basePath = `/workspace/${workspace.slug}/settings/providers`

  const header = (
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
        Where each runtime gets its model from. Runtimes differ here in kind, not just in detail, so each one gets
        its own tab rather than a shared screen that would be wrong for both.
      </p>
    </div>
  )

  if (!selectedRuntime) {
    return (
      <main className="w-full px-5 py-8">
        {header}
        <p className="text-sm text-black/50 dark:text-white/50">
          No enabled runtimes in this workspace yet. Add one on the{' '}
          <Link
            href={`/workspace/${workspace.slug}/settings/runtimes`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Runtimes page
          </Link>
          .
        </p>
      </main>
    )
  }

  // ---- A runtime that carries its own model catalogue -----------------------
  if (!usesHermesHome(selectedRuntime)) {
    const handshake = (selectedRuntime.handshake ?? null) as AgentHandshake | null
    const options = sessionConfigOptions(handshake)
    return (
      <main className="w-full px-5 py-8">
        {header}
        <RuntimeTabs basePath={basePath} tabs={tabs} selectedId={selectedRuntime.id} />
        <div className="flex flex-col gap-4">
          <p className="text-sm text-black/50 dark:text-white/50">
            {selectedRuntime.name} holds its own credentials and tells us which models it offers. Everything below
            came from the runtime itself when it was last probed — this app maintains no model list, which is why a
            new model needs no release from us.
          </p>

          {options === undefined ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              This runtime has not been probed yet, so nothing is known about what it offers. Probe it on the{' '}
              <Link
                href={`/workspace/${workspace.slug}/settings/runtimes`}
                className="font-medium underline underline-offset-2"
              >
                Runtimes page
              </Link>
              . Not knowing is different from there being nothing.
            </p>
          ) : options.length === 0 ? (
            <p className="rounded-md border border-black/10 bg-black/[0.02] px-3 py-2 text-sm text-black/50 dark:border-white/10 dark:bg-white/[0.03] dark:text-white/50">
              This runtime declares no settings of its own — it chooses its model internally.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {options.map((option) => (
                <section key={option.id} className="rounded-lg border border-black/10 p-4 dark:border-white/10">
                  <h2 className="text-sm font-semibold">{option.name}</h2>
                  {option.description && (
                    <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{option.description}</p>
                  )}
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {(option.options ?? []).map((choice) => (
                      <li key={choice.value} className="flex items-baseline gap-2 text-sm">
                        <span className="font-mono text-xs text-black/45 dark:text-white/45">{choice.value}</span>
                        <span>{choice.name}</span>
                        {choice.value === option.currentValue && (
                          <span className="rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-black/50 dark:bg-white/[0.09] dark:text-white/50">
                            runtime default
                          </span>
                        )}
                        {choice.description && (
                          <span className="text-xs text-black/40 dark:text-white/40">{choice.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <p className="text-xs text-black/45 dark:text-white/45">
                These are chosen per agent, not globally — pick one on an agent&apos;s{' '}
                <Link
                  href={`/workspace/${workspace.slug}/agents`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Settings tab
                </Link>{' '}
                and it is applied to that agent&apos;s sessions.
              </p>
            </div>
          )}
        </div>
      </main>
    )
  }

  // ---- Hermes: profiles, providers and keys --------------------------------
  //
  // Only reached for a Hermes runtime, so a workspace whose selected tab is
  // something else never pays for these filesystem reads.
  const profiles = await listHermesProfiles()
  const selectedProfile = profiles.some((entry) => entry.name === (profileParam ?? '')) ? (profileParam ?? '') : ''

  const [active, providers, envSlots] = await Promise.all([
    getActiveModelConfig(selectedProfile || null),
    listKnownProviders(selectedProfile || null),
    listProviderEnvSlots(),
  ])
  const keyStatus = await listProviderKeyStatus(providers.map((p) => p.provider))

  return (
    <main className="w-full px-5 py-8">
      {header}
      <RuntimeTabs basePath={basePath} tabs={tabs} selectedId={selectedRuntime.id} />
      <p className="mb-4 text-sm text-black/50 dark:text-white/50">
        Which AI provider and model each Hermes profile uses — real, live config from this machine. Every profile is
        its own complete Hermes home, so an agent pinned to a profile answers with that profile&apos;s model and
        credentials.
      </p>
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
