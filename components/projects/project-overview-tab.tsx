'use client'

import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { updateProject } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'

export interface ProjectStatusCount {
  category: string
  label: string
  count: number
}

// ROADMAP B-1 (project detail, Overview tab) — "the missing centre of the
// product." The plan text asks for the brief as a real BlockSuite document
// "agents read this as context on every run." Two things checked before
// building that:
//   1. `collections/Projects.ts` has no document/body field wired to
//      `lib/blocksuite-doc.ts`'s machinery today — only a plain `description`
//      textarea. Half-wiring BlockSuite into a schema never meant to hold it
//      (per the task brief's own instruction) would be worse than being
//      honest about what exists, so this is a plain textarea + save, not a
//      fake editor.
//   2. Nothing in `lib/hermes/` or `lib/dispatcher/` reads a project's
//      description into a run's prompt/context today (confirmed by search —
//      the only "no description field" comment in this codebase is about
//      *tasks*, not projects, and neither `acp-client.ts` nor
//      `run-with-identity.ts` nor `worker.ts` reference `project.description`
//      anywhere). The marker text below says so plainly instead of claiming
//      the roadmap's aspiration is already true.
export function ProjectOverviewTab({
  projectId,
  workspaceSlug,
  initialDescription,
  statusCounts,
  activeRunCount,
  totalCostTicks,
  lastActivityAt,
}: {
  projectId: number
  workspaceSlug: string
  initialDescription: string | null
  statusCounts: ProjectStatusCount[]
  activeRunCount: number
  totalCostTicks: number
  lastActivityAt: string | null
}) {
  const [description, setDescription] = useState(initialDescription ?? '')
  const [saved, setSaved] = useState(initialDescription ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = description !== saved

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProject({ projectId, workspaceSlug, data: { description } })
      setSaved(updated.description ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save brief.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Brief</h2>
          {dirty && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project for? Give agents and teammates the context they need."
          autoResize
          className="min-h-[140px]"
        />
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
        {!description && !dirty && <p className="mt-1 text-xs text-black/40 dark:text-white/40">No brief yet — add one above.</p>}
        <p className="mt-2 text-xs text-black/40 dark:text-white/40">
          Not yet wired into run context — agents don&apos;t read this brief automatically today.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Status</h2>
        <div className="flex flex-wrap gap-2">
          {statusCounts
            .filter((s) => s.count > 0)
            .map((s) => (
              <div
                key={s.category}
                className="rounded-md border border-black/10 px-2.5 py-1.5 text-xs dark:border-white/10"
              >
                <span className="font-medium">{s.count}</span> <span className="text-black/50 dark:text-white/50">{s.label}</span>
              </div>
            ))}
          {statusCounts.every((s) => s.count === 0) && (
            <p className="text-sm text-black/40 dark:text-white/40">No tasks yet.</p>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-black/40 dark:text-white/40">Active runs</dt>
            <dd className="mt-0.5 font-medium">{activeRunCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-black/40 dark:text-white/40">30-day spend</dt>
            <dd className="mt-0.5 font-medium">${(totalCostTicks / 100).toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-xs text-black/40 dark:text-white/40">Last activity</dt>
            <dd className="mt-0.5 font-medium">{lastActivityAt ? new Date(lastActivityAt).toLocaleString() : '—'}</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
