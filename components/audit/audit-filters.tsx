'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const ALL = '__all__'

// ROADMAP B7.3 (Batch B-6 "Finish") — three URL-driven filters (actor, verb,
// entity type) for the workspace audit log. Plain URL search params rather
// than client-side state, so a filtered view is linkable/shareable and
// changing a filter re-runs the server component's own query (no separate
// client-side fetch/cache to keep in sync with the server-rendered list).
export function AuditFilters({
  actor,
  verb,
  entityType,
  actorOptions,
  verbOptions,
  entityTypeOptions,
}: {
  actor: string
  verb: string
  entityType: string
  actorOptions: { id: number; label: string }[]
  verbOptions: string[]
  entityTypeOptions: string[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (!value || value === ALL) next.delete(key)
    else next.set(key, value)
    next.delete('page') // any filter change resets pagination
    router.push(`${pathname}?${next.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={actor || ALL} onValueChange={(v) => setParam('actor', v)}>
        <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Any actor" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any actor</SelectItem>
          {actorOptions.map((option) => (
            <SelectItem key={option.id} value={String(option.id)}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={verb || ALL} onValueChange={(v) => setParam('verb', v)}>
        <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Any verb" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any verb</SelectItem>
          {verbOptions.map((v) => (
            <SelectItem key={v} value={v}>{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={entityType || ALL} onValueChange={(v) => setParam('entityType', v)}>
        <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Any entity" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any entity</SelectItem>
          {entityTypeOptions.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(actor || verb || entityType) && (
        <button
          type="button"
          onClick={() => router.push(pathname)}
          className="text-xs text-black/40 underline underline-offset-2 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
