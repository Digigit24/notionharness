import { RuntimeDefaultsForm } from '@/components/runtimes/runtime-defaults-form'
import type { AgentHandshake } from '@/lib/runtimes/handshake'
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
import { RuntimeProbeButton } from '@/components/runtimes/probe-button'
import { explainProbeCode } from '@/lib/runtimes/probe-codes'
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
    <main className="w-full px-5 py-8">
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
  const info = (runtime?.connectionInfo ?? null) as {
    error?: string
    profilesAvailable?: number
    /** Present only for a runtime that HAS a dashboard. Reported separately
     * from `status` on purpose: a runtime whose dashboard is unreachable can
     * still run turns perfectly well, and folding the two together reported a
     * working Hermes as "down" purely because a side service was returning
     * 502. */
    dashboard?: { reachable?: boolean; statusCode?: number; error?: string; url?: string }
  } | null

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
            <RuntimeProbeButton
              profileId={profile.id}
              workspaceSlug={workspaceSlug}
              lastCode={profile.lastProbeCode}
              lastDetail={profile.lastProbeDetail}
              agentName={
                profile.handshake && typeof profile.handshake === 'object'
                  ? ((profile.handshake as { agentName?: string | null }).agentName ?? null)
                  : null
              }
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

        {status === 'down' && info?.error && <DownReason error={info.error} />}

        {/* A specific, real state worth naming: the runtime runs, but the
            Hermes-only settings screens (profiles, memories, MCP config) have
            no server to talk to. Saying that is far more useful than either
            hiding it or letting it turn the whole runtime red. */}
        {info?.dashboard && info.dashboard.reachable === false && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Runs fine, but its Hermes dashboard is unreachable
            {info.dashboard.statusCode ? ` (${info.dashboard.statusCode})` : ''}
            {info.dashboard.url ? ` at ${info.dashboard.url}` : ''} — profiles, memories and MCP settings will not
            load until it is back.
          </p>
        )}

        {/* R12-P4.2 - the runtime's own settings, edited here rather than
            once per agent. Rendered from what the runtime declared about
            itself at probe time, so there is no Claude-specific screen and no
            model list of ours to keep current. */}
        <RuntimeDefaultsForm
          workspaceSlug={workspaceSlug}
          profileId={profile.id}
          handshake={(profile.handshake as AgentHandshake | null) ?? null}
          initialValues={
            profile.defaultSessionConfig && typeof profile.defaultSessionConfig === 'object'
              ? (profile.defaultSessionConfig as Record<string, unknown>)
              : {}
          }
        />

        <div className="text-xs text-faint">
          {agents.length === 0
            ? 'No agents bound to this runtime.'
            : `Agents: ${agents.map((a) => a.name).join(', ')}. They inherit the defaults above unless they set their own.`}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Why a runtime is down.
 *
 * `connectionInfo.error` holds free-form text most of the time, but the health
 * loop falls back to the bare probe code when a stored probe had no detail
 * (see `checkAcpRuntime` in `lib/runtimes/hermes/runtime-health.ts`), so this
 * line could read exactly `acp_init_timeout` and nothing else. When that
 * happens, say what it means and what to do instead — same map the Probe
 * button uses, so the two never disagree about one code.
 */
function DownReason({ error }: { error: string }) {
  const explanation = explainProbeCode(error)
  if (!explanation) return <p className="text-xs text-destructive">{error}</p>
  return (
    <p className="text-xs text-destructive">
      {explanation.title}. {explanation.whatItMeans} <span className="font-medium">{explanation.whatToDo}</span>
    </p>
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
