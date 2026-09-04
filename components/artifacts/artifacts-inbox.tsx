'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FileText, Inbox, Code2 } from 'lucide-react'

import { fileArtifacts } from '@/app/(app)/workspace/[workspaceSlug]/artifacts/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { useOptimisticAction } from '@/lib/optimistic'
import { formatRelativeTime } from '@/lib/relative-time'

const ALL = '__all__'

export interface ArtifactCard {
  id: number
  name: string
  kind: 'page' | 'html'
  createdAt: string
  pageId: number | null
  preview: string | null
  icon: string | null
  agentId: number | null
  agentName: string | null
  sessionId: number | null
  sessionTitle: string | null
}

/**
 * R8.4 — the triage list.
 *
 * Filters are URL search params rather than client state, matching
 * `components/audit/audit-filters.tsx`: a filtered view stays linkable, and
 * changing one re-runs the server component's own query instead of
 * introducing a second client-side cache to keep in sync with it.
 *
 * Selection is NOT in the URL. It is transient, it is per-person, and a
 * shared link that arrives with four things pre-ticked would be a bug rather
 * than a feature.
 */
export function ArtifactsInbox({
  workspaceSlug,
  artifacts,
  agents,
  sessions,
  projects,
  kind,
  agent,
  session,
}: {
  workspaceSlug: string
  artifacts: ArtifactCard[]
  agents: { id: number; name: string }[]
  sessions: { id: number; title: string }[]
  projects: { id: number; name: string; icon: string | null }[]
  kind: string
  agent: string
  session: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [isPending, startTransition] = useTransition()
  // Mirrors `artifacts` so a filed row leaves the list the instant filing
  // succeeds, instead of waiting on `router.refresh()`'s full round trip
  // (D0) — resynced whenever the server sends a fresh page (a filter change,
  // or the background refresh below landing).
  const [items, setItems] = useState(artifacts)
  useEffect(() => {
    setItems(artifacts)
  }, [artifacts])
  const { run, pending: busy } = useOptimisticAction<{ filed: number }>()

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (!value || value === ALL) next.delete(key)
    else next.set(key, value)
    // A filter change can hide the artifact the panel is showing, and a panel
    // open over a list that no longer contains its subject is confusing.
    next.delete('artifact')
    router.push(`${pathname}?${next.toString()}`)
    setSelected(new Set())
  }

  /** Opening preserves the current filters, so closing the panel returns to
   * the list the human was actually looking at. */
  const openHref = useMemo(() => {
    return (id: number) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set('artifact', String(id))
      return `${pathname}?${next.toString()}`
    }
  }, [pathname, searchParams])

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function file(ids: number[], projectId: number) {
    const idSet = new Set(ids)
    const previousItems = items
    const previousSelected = selected
    const project = projects.find((p) => p.id === projectId)
    void run({
      // Filing's whole visible effect is the row leaving this list (R8.3) —
      // paint that now rather than waiting for the server to confirm it and
      // then a `router.refresh()` on top of that.
      apply: () => {
        setItems((current) => current.filter((a) => !idSet.has(a.id)))
        setSelected(new Set())
      },
      rollback: () => {
        setItems(previousItems)
        setSelected(previousSelected)
      },
      work: () => fileArtifacts({ workspaceSlug, artifactIds: ids, projectId }),
      failureTitle: 'Could not file',
      onSettled: ({ filed }) => {
        toast({
          title: filed === 1 ? `Filed into ${project?.name ?? 'the project'}` : `Filed ${filed} artifacts into ${project?.name ?? 'the project'}`,
          // Says what filing did, because "it disappeared from this list" is
          // the visible effect and R8.3 wants that understood as a move.
          description: 'It has moved out of this list and into the project.',
        })
        startTransition(() => router.refresh())
      },
    })
  }

  const disabled = busy || isPending

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Artifacts</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Documents agents wrote that have nowhere to live yet. File each one into a project, or open it and keep working.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={kind || ALL} onValueChange={(v) => setParam('kind', v)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Any kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any kind</SelectItem>
            <SelectItem value="page">Page</SelectItem>
            <SelectItem value="html">HTML</SelectItem>
          </SelectContent>
        </Select>

        <Select value={agent || ALL} onValueChange={(v) => setParam('agent', v)}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Any agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any agent</SelectItem>
            {agents.map((option) => (
              <SelectItem key={option.id} value={String(option.id)}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={session || ALL} onValueChange={(v) => setParam('session', v)}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue placeholder="Any session" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any session</SelectItem>
            {/* Only sessions that produced something in this list. A picker
                over every session in the workspace would mostly offer
                choices that select nothing. */}
            {sessions.map((option) => (
              <SelectItem key={option.id} value={String(option.id)}>
                {option.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10">
            <span className="text-sm text-black/60 dark:text-white/60">{selected.size} selected</span>
            <FileIntoProject
              projects={projects}
              disabled={disabled}
              label="File selected"
              onPick={(projectId) => file([...selected], projectId)}
            />
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="Nothing to file"
          // R8.4: "the empty state says what it means. Nothing here is the
          // healthy state, not a missing feature, and the copy should say so."
          description="An empty inbox is the healthy state. Artifacts land here only when an agent writes one outside a project — a session bound to a project files its own work, so it never appears in this list."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((artifact) => (
            <li
              key={artifact.id}
              className="flex items-start gap-3 rounded-lg border border-black/10 px-3 py-3 hover:bg-black/[.02] dark:border-white/10 dark:hover:bg-white/[.03]"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={selected.has(artifact.id)}
                onChange={() => toggle(artifact.id)}
                aria-label={`Select ${artifact.name}`}
              />
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-black/[.06] text-base dark:bg-white/10">
                {artifact.icon ||
                  (artifact.kind === 'html' ? (
                    <Code2 size={16} className="text-black/40 dark:text-white/40" />
                  ) : (
                    <FileText size={16} className="text-black/40 dark:text-white/40" />
                  ))}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Prefetched: opening the panel is a navigation on this
                      same route, so warming it on hover means the click
                      itself does not wait on the server. */}
                  <Link href={openHref(artifact.id)} scroll={false} className="truncate font-medium hover:underline">
                    {artifact.name}
                  </Link>
                  <Badge variant="secondary">{artifact.kind}</Badge>
                </div>
                {artifact.preview && (
                  <p className="mt-1 line-clamp-2 text-sm text-black/50 dark:text-white/50">{artifact.preview}</p>
                )}
                <p className="mt-1 text-xs text-black/40 dark:text-white/40">
                  {artifact.agentName ?? 'A person'}
                  {artifact.sessionTitle ? ` · ${artifact.sessionTitle}` : ''}
                  {` · ${formatRelativeTime(artifact.createdAt)}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <FileIntoProject
                  projects={projects}
                  disabled={disabled}
                  label="File into…"
                  onPick={(projectId) => file([artifact.id], projectId)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * The one control R8.4 asks for: "file into a project is the primary action
 * on every card, and it is one control." A select rather than a dialog — the
 * whole decision is which project, and a dialog would add a confirm step to
 * an action that is reversible by filing it back.
 */
function FileIntoProject({
  projects,
  disabled,
  label,
  onPick,
}: {
  projects: { id: number; name: string; icon: string | null }[]
  disabled: boolean
  label: string
  onPick: (projectId: number) => void
}) {
  if (projects.length === 0) {
    // Honest rather than a dead control: with no projects there is nowhere to
    // file to, and the fix is creating one.
    return <span className="text-xs text-black/40 dark:text-white/40">No projects yet</span>
  }
  return (
    <Select
      // Never holds a value: picking is an action, not a setting, and the
      // artifact leaves the list as soon as it succeeds.
      value=""
      disabled={disabled}
      onValueChange={(value) => {
        const id = Number(value)
        if (Number.isFinite(id)) onPick(id)
      }}
    >
      <SelectTrigger size="sm" className="w-36">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={String(project.id)}>
            {project.icon ? `${project.icon} ${project.name}` : project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
