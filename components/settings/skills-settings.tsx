'use client'

import { useMemo, useState, useTransition } from 'react'
import { Check, Loader2, Pencil, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProfilePills } from './profile-pills'
import {
  readSkill,
  setSkillEnabled,
  writeSkill,
  type SkillsSettings,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/skills/actions'
import { formatCount } from '@/lib/relative-time'

/** Skills for one Hermes profile: enable, disable, read and edit. */
export function SkillsSettingsView({
  workspaceSlug,
  settings,
}: {
  workspaceSlug: string
  settings: SkillsSettings
}) {
  const [skills, setSkills] = useState(settings.skills)
  const [query, setQuery] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [error, setError] = useState<string | null>(settings.error)
  const [busy, startTransition] = useTransition()

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loadingContent, setLoadingContent] = useState(false)

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = skills.filter((skill) => {
      if (onlyEnabled && !skill.enabled) return false
      if (!needle) return true
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.category.toLowerCase().includes(needle)
      )
    })
    const map = new Map<string, typeof matches>()
    for (const skill of matches) {
      const list = map.get(skill.category)
      if (list) list.push(skill)
      else map.set(skill.category, [skill])
    }
    return [...map.entries()].sort((a, b) => (a[0] || '').localeCompare(b[0] || ''))
  }, [skills, query, onlyEnabled])

  const enabledCount = skills.filter((s) => s.enabled).length

  function toggle(name: string, enabled: boolean) {
    // Optimistic: the list is long and a round-trip per checkbox made this
    // feel broken. Reverted below if the write fails.
    setSkills((current) => current.map((s) => (s.name === name ? { ...s, enabled } : s)))
    setError(null)
    startTransition(async () => {
      try {
        await setSkillEnabled({ workspaceSlug, profile: settings.profile, name, enabled })
      } catch (err) {
        setSkills((current) => current.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s)))
        setError(err instanceof Error ? err.message : 'Could not change that skill.')
      }
    })
  }

  function openEditor(name: string) {
    setEditing(name)
    setDraft('')
    setLoadingContent(true)
    setError(null)
    startTransition(async () => {
      try {
        setDraft(await readSkill(settings.profile, name))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read that skill.')
        setEditing(null)
      } finally {
        setLoadingContent(false)
      }
    })
  }

  function save() {
    if (!editing) return
    setError(null)
    startTransition(async () => {
      try {
        await writeSkill({ workspaceSlug, profile: settings.profile, name: editing, content: draft })
        setEditing(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that skill.')
      }
    })
  }

  return (
    <main className="w-full max-w-4xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">Skills</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          The skill library for this profile. Enabling one here makes it available to the profile; an agent
          still chooses which of them it loads.
        </p>
      </header>

      <ProfilePills
        profiles={settings.profiles}
        active={settings.profile}
        basePath={`/workspace/${workspaceSlug}/settings/skills`}
      />

      {error && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-black/30 dark:text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills"
            className="w-64 rounded-lg border border-black/10 bg-transparent py-1.5 pl-7 pr-2 text-xs outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-black/60 dark:text-white/60">
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
          Enabled only
        </label>
        <span className="text-xs text-black/40 dark:text-white/40">
          {formatCount(enabledCount)} of {formatCount(skills.length)} enabled
        </span>
      </div>

      {editing && (
        <section className="mb-5 rounded-lg border border-black/15 p-3 dark:border-white/15">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{editing}</h2>
            <span className="flex gap-1.5">
              <Button size="sm" disabled={busy || loadingContent} onClick={save}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X size={12} />
                Close
              </Button>
            </span>
          </div>
          {loadingContent ? (
            <p className="text-xs text-black/40 dark:text-white/40">Loading…</p>
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-black/10 bg-transparent p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
            />
          )}
        </section>
      )}

      {grouped.length === 0 && (
        <p className="text-xs text-black/40 dark:text-white/40">No skills match.</p>
      )}

      {grouped.map(([category, items]) => (
        <section key={category} className="mb-4">
          <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
            {category}
          </h2>
          <ul className="divide-y divide-black/[0.06] rounded-lg border border-black/10 dark:divide-white/[0.08] dark:border-white/10">
            {items.map((skill) => (
              <li key={skill.name} className="flex items-start gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={(e) => toggle(skill.name, e.target.checked)}
                  className="mt-0.5"
                  aria-label={`Enable ${skill.name}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{skill.name}</span>
                    <span className="shrink-0 rounded border border-black/10 px-1 text-[9px] uppercase text-black/40 dark:border-white/10 dark:text-white/40">
                      {skill.provenance}
                    </span>
                    {skill.usage > 0 && (
                      <span className="shrink-0 text-[10px] text-black/35 dark:text-white/35">
                        used {formatCount(skill.usage)}×
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-black/45 dark:text-white/45">
                    {skill.description}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Edit ${skill.name}`}
                  onClick={() => openEditor(skill.name)}
                  className="shrink-0 rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <Pencil size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
