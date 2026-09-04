import { notFound } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { SwitchActiveProfileButton } from '@/components/personality/switch-profile-button'
import { getActiveHermesProfile, listHermesIdentities, listHermesProfiles } from '@/lib/hermes/personas'

export const metadata = {
  title: 'Personality | NotionForge',
}

// Phase C, C2 — "Personalities: SOUL.md plus /personality — a card per
// persona with a live preview and one-click switch." Reads this machine's
// REAL Hermes install (see lib/hermes/personas.ts's own header comment for
// exactly what is and isn't read, and AGENTS.md's Phase C notes for how
// this was discovered and confirmed to be the user's actual live WhatsApp
// business assistant, not a dev fixture — building the write/switch half
// of this page was an explicit, informed choice the user made, not an
// unprompted one).
export default async function PersonalityPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  let identities: Awaited<ReturnType<typeof listHermesIdentities>> = []
  let profiles: Awaited<ReturnType<typeof listHermesProfiles>> = []
  let activeProfile: string | null = null
  let loadError: string | null = null
  try {
    ;[identities, profiles, activeProfile] = await Promise.all([
      listHermesIdentities(),
      listHermesProfiles(),
      getActiveHermesProfile(),
    ])
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not read Hermes identity/profile files.'
  }

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[{ label: workspace.name, href: `/workspace/${workspace.slug}` }, { label: 'Personality' }]}
        />
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Sparkles size={20} />
          Personality
        </h1>
        <p className="mt-1 text-sm text-faint">
          This installation talks to one Hermes (Phase C, C1) — these are its real profile workspaces and per-sender
          identity overrides, read directly from disk. This installation talks to real WhatsApp senders; switching
          the active profile is a real, live change, not a preview.
        </p>
      </div>

      {loadError ? (
        <EmptyState icon={<Sparkles />} title="Could not load Hermes personas" description={loadError} />
      ) : (
        <>
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-medium">Profiles</h2>
            {profiles.length === 0 ? (
              <EmptyState icon={<Sparkles />} title="No Hermes profiles found" description="Nothing under this install's profiles/ directory." />
            ) : (
              <ul className="flex flex-col gap-3">
                {profiles.map((profile) => (
                  <li key={profile.name}>
                    <Card>
                      <CardContent className="flex items-start justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{profile.soul?.title ?? profile.name}</span>
                            <Badge variant="outline" className="text-faint">
                              {profile.name}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-faint">
                            {profile.soul?.preview ?? 'No SOUL.md found for this profile.'}
                          </p>
                        </div>
                        <div className="shrink-0">
                          <SwitchActiveProfileButton
                            workspaceSlug={workspace.slug}
                            profileName={profile.name}
                            isActive={profile.name === activeProfile}
                          />
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium">Per-sender identities</h2>
            <p className="mb-3 text-xs text-faint">
              Override the active profile&apos;s persona for a specific WhatsApp sender, via sender-routing.json — view-only here.
            </p>
            {identities.length === 0 ? (
              <EmptyState icon={<Sparkles />} title="No per-sender identities found" description="Nothing under this install's identities/ directory." />
            ) : (
              <ul className="flex flex-col gap-3">
                {identities.map((identity) => (
                  <li key={identity.slug}>
                    <Card>
                      <CardContent className="py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{identity.title}</span>
                          <Badge variant="outline" className="text-faint">
                            {identity.slug}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-faint">{identity.preview}</p>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  )
}
