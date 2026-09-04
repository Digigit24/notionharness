'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { updateProject } from '@/app/(app)/workspace/[workspaceSlug]/projects/[projectId]/actions'
import type { Project } from '@/payload-types'

// ROADMAP B-1 (project detail, Settings tab) — `collections/Projects.ts`
// only has name/icon/description today (confirmed by reading the collection
// file in full): no repo/directory binding, no defaultAgent/defaultRuntime,
// no members, no archive/status field. This form edits exactly the fields
// that exist and says so for the ones that don't, rather than rendering
// controls for a schema this pass didn't add.
export function ProjectSettingsTab({
  project,
  workspaceSlug,
  onUpdated,
  compact = false,
}: {
  project: Project
  workspaceSlug: string
  onUpdated: (project: Project) => void
  /** Rendered in the detail page's right rail rather than as a full tab:
   * drops the page padding and the max-width, which exist for a tab body and
   * would waste most of a 320px column. */
  compact?: boolean
}) {
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState(project.icon ?? '')
  const [description, setDescription] = useState(project.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const dirty = name !== project.name || icon !== (project.icon ?? '') || description !== (project.description ?? '')

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProject({
        projectId: project.id,
        workspaceSlug,
        data: { name: name || 'Untitled', icon: icon || null, description: description || null },
      })
      onUpdated(updated)
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={compact ? 'flex flex-col gap-3' : 'flex max-w-lg flex-col gap-4 p-6'}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Icon">
        <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Emoji, e.g. 🚀" className="w-24" />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} autoResize className="min-h-[100px]" />
      </Field>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void handleSave()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {!dirty && savedAt && <span className="text-xs text-black/40 dark:text-white/40">Saved</span>}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      <p className="mt-2 text-xs text-black/40 dark:text-white/40">
        Repo/directory binding, default runtime, default agent, members, and archive aren&apos;t fields on projects yet — this
        form only edits what exists today.
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-black/40 dark:text-white/40">{label}</span>
      {children}
    </label>
  )
}
