import { notFound } from 'next/navigation'
import { Server } from 'lucide-react'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { RuntimesRefreshButton } from '@/components/runtimes/refresh-button'
import { AddRuntimeProfileForm } from '@/components/runtimes/add-profile-form'
import { ToggleRuntimeProfileEnabledButton } from '@/components/runtimes/toggle-enabled-button'
import { formatRelativeTime } from '@/lib/relative-time'
import type { Agent, Runtime, RuntimeProfile } from '@/payload-types'

export const metadata = {
  title: 'Runtimes | NotionForge',
}

// Phase C, C1.4 — the route the roadmap doc named as "the one that does not
// exist yet." Presence + profiles-on-that-machine + agents-bound-to-it, per
// its own spec; the live-terminal button it also asks for is deliberately
// NOT here — that's C5/xterm's job (node-pty has no browser-facing terminal
// UI yet, see AGENTS.md's Phase C notes), and a disabled placeholder button
// would be exactly the kind of fabricated affordance this codebase's own
// stated discipline (see the health page's header comment) argues against.
export default async function RuntimesPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const [profiles, runtimes, agents] = await Promise.all([
    payload.find({
      collection: 'runtime-profiles',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'runtimes',
      where: { workspace: { equals: workspace.id } },
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id } },
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  const runtimeByProfileId = new Map<number, Runtime>()
  for (const runtime of runtimes.docs) {
    const profileId = typeof runtime.runtimeProfile === 'object' ? runtime.runtimeProfile.id : runtime.runtimeProfile
    runtimeByProfileId.set(profileId, runtime)
  }
  const agentsByProfileId = new Map<number, Agent[]>()
  for (const agent of agents.docs) {
    const profileId = typeof agent.runtimeProfile === 'object' ? agent.runtimeProfile.id : agent.runtimeProfile
    const list = agentsByProfileId.get(profileId) ?? []
    list.push(agent)
    agentsByProfileId.set(profileId, list)
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Breadcrumbs
            className="mb-2"
            segments={[{ label: workspace.name, href: `/workspace/${workspace.slug}` }, { label: 'Runtimes' }]}
          />
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Server size={20} />
            Runtimes
          </h1>
          <p className="mt-1 text-sm text-faint">
            Every runtime profile this workspace can dispatch to, and whether Hermes actually reached it the last
            time anyone checked. This installation talks to one Hermes (Phase C, C1) — per-machine runtimes are a
            later milestone.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RuntimesRefreshButton />
        </div>
      </div>

      <div className="mb-4">
        <AddRuntimeProfileForm workspaceId={workspace.id} workspaceSlug={workspace.slug} />
      </div>

      {profiles.docs.length === 0 ? (
        <EmptyState icon={<Server />} title="No runtime profiles yet" description="Add one above to get started." />
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.docs.map((profile) => (
            <RuntimeRow
              key={profile.id}
              workspaceSlug={workspace.slug}
              profile={profile}
              runtime={runtimeByProfileId.get(profile.id) ?? null}
              agents={agentsByProfileId.get(profile.id) ?? []}
            />
          ))}
        </ul>
      )}
    </main>
  )
}

function RuntimeRow({
  workspaceSlug,
  profile,
  runtime,
  agents,
}: {
  workspaceSlug: string
  profile: RuntimeProfile
  runtime: Runtime | null
  agents: Agent[]
}) {
  const status = runtime?.status ?? 'unknown'
  const info = (runtime?.connectionInfo ?? null) as { error?: string; profilesAvailable?: number } | null

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <PresenceDot status={status} />
            <span className="text-sm font-medium">{profile.name}</span>
            {!profile.enabled && (
              <Badge variant="outline" className="text-faint">
                Disabled
              </Badge>
            )}
            <ToggleRuntimeProfileEnabledButton
              workspaceSlug={workspaceSlug}
              profileId={profile.id}
              enabled={Boolean(profile.enabled)}
            />
          </div>
          <span className="text-xs text-faint">
            {runtime?.lastCheckedAt ? `Checked ${formatRelativeTime(runtime.lastCheckedAt)}` : 'Never checked'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
          <span>
            {profile.protocolFamily.toUpperCase()} · <code>{profile.commandName}</code>
          </span>
          {runtime?.host && <span>Host: {runtime.host}</span>}
          {info?.profilesAvailable != null && <span>{info.profilesAvailable} Hermes profile(s) available</span>}
        </div>

        {status === 'down' && info?.error && (
          <p className="text-xs text-destructive">{info.error}</p>
        )}

        <div className="text-xs text-faint">
          {agents.length === 0
            ? 'No agents bound to this runtime.'
            : `Agents: ${agents.map((a) => a.name).join(', ')}`}
        </div>
      </CardContent>
    </Card>
  )
}

function PresenceDot({ status }: { status: 'up' | 'down' | 'unknown' }) {
  const color =
    status === 'up'
      ? 'bg-emerald-500'
      : status === 'down'
        ? 'bg-red-500'
        : 'bg-black/20 dark:bg-white/20'
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color}`} title={status} />
}
