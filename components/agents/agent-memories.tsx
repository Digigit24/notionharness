'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Agent } from '@/components/agents/agent-editor'

// ROADMAP B7.1 (Batch B-6 "Finish") — "List what an agent has learned, each
// entry readable, editable and deletable, with the run that learned it."
// Deliberately shaped as a sibling of agent-capabilities.tsx's Skills
// library block (list -> select -> edit/save -> two-click delete), against
// the new app/api/hermes/memories/* proxy — see that route's own header
// comment for the inferred-vs-confirmed Hermes endpoint-shape caveat.
//
// Two honest caveats surfaced directly in this UI, not just in comments:
//   1. Last-writer-wins: lib/hermes/home-overlay.ts documents that memory is
//      a real, persistent per-agent directory Hermes rewrites *whole* on
//      each write, and two concurrent runs of the same agent share that one
//      directory — so a second run's write can silently clobber the first's,
//      with no merge. This is a real architectural fact, not a hypothetical.
//   2. "The run that learned it": no mechanism in this codebase tags a
//      memory entry with the run that wrote it (Hermes rewrites the file
//      whole; nothing here records a run id alongside it). If the live
//      payload happens to include one (checked defensively below under a
//      few likely field names), it's shown; otherwise this is honestly
//      labeled unavailable rather than fabricated.

type MemoryItem = {
  name: string
  description: string
  size: number | null
  modifiedAt: string | null
  runId: string | null
  raw: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function firstString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function firstNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function extractArrayFromPayload(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = asRecord(payload)
  for (const key of keys) {
    const value = root[key]
    if (Array.isArray(value)) return value
  }
  if (Array.isArray(root.data)) return root.data
  return []
}

function formatBytes(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function extractMemoryItems(payload: unknown): MemoryItem[] {
  const rows = extractArrayFromPayload(payload, ['memories', 'items'])
  return rows
    .map((row) => {
      const raw = asRecord(row)
      const name =
        firstString(raw.name) ||
        firstString(raw.file) ||
        firstString(raw.id) ||
        firstString(raw.slug)
      if (!name) return null
      return {
        name,
        description: firstString(raw.description) || firstString(raw.summary),
        size: firstNumber(raw.size) ?? firstNumber(raw.bytes) ?? firstNumber(raw.fileSize),
        modifiedAt:
          firstString(raw.modifiedAt) ||
          firstString(raw.updatedAt) ||
          firstString(raw.mtime) ||
          null,
        // Best-effort only — see file header caveat #2. No known live
        // payload has been confirmed to carry any of these; checked in case
        // Hermes does report one.
        runId:
          firstString(raw.runId) ||
          firstString(raw.lastRunId) ||
          firstString(raw.sourceRunId) ||
          firstString(raw.learnedFromRunId) ||
          null,
        raw,
      }
    })
    .filter((item): item is MemoryItem => item !== null)
}

function readContentString(payload: unknown): string {
  if (typeof payload === 'string') return payload
  const root = asRecord(payload)
  return (
    firstString(root.content) ||
    firstString(root.text) ||
    firstString(root.value) ||
    ''
  )
}

export function AgentMemories({ agent }: { agent: Agent }) {
  const profile = agent.name

  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')

  const [selected, setSelected] = useState<string>('')
  const [content, setContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState('')

  const [saveBusy, setSaveBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setListError('')
      try {
        const response = await fetch(`/api/hermes/memories?profile=${encodeURIComponent(profile)}`, { cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok) {
          throw new Error(firstString(asRecord(payload).error) || 'Failed to load memories')
        }
        if (!cancelled) {
          const items = extractMemoryItems(payload).sort((a, b) => a.name.localeCompare(b.name))
          setMemories(items)
        }
      } catch (error) {
        if (!cancelled) {
          setListError(error instanceof Error ? error.message : 'Failed to load memories')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [profile])

  useEffect(() => {
    let cancelled = false
    const loadContent = async () => {
      if (!selected) {
        setContent('')
        return
      }
      setContentLoading(true)
      setContentError('')
      setSaveStatus('')
      try {
        const params = new URLSearchParams({ profile, name: selected })
        const response = await fetch(`/api/hermes/memories/content?${params.toString()}`, { cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok) {
          throw new Error(firstString(asRecord(payload).error) || `Failed to load ${selected}`)
        }
        if (!cancelled) setContent(readContentString(payload))
      } catch (error) {
        if (!cancelled) {
          setContentError(error instanceof Error ? error.message : 'Failed to load memory content')
          setContent('')
        }
      } finally {
        if (!cancelled) setContentLoading(false)
      }
    }
    void loadContent()
    return () => {
      cancelled = true
    }
  }, [profile, selected])

  async function saveContent() {
    if (!selected.trim()) return
    setSaveBusy(true)
    setSaveStatus('')
    try {
      const response = await fetch('/api/hermes/memories/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, name: selected.trim(), content }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || 'Failed to save memory')
      }
      setSaveStatus('Saved.')
      if (!memories.some((m) => m.name === selected)) {
        setMemories((current) => [
          ...current,
          { name: selected, description: '', size: null, modifiedAt: null, runId: null, raw: {} },
        ])
      }
    } catch (error) {
      setSaveStatus(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setSaveBusy(false)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleteBusy(true)
    setSaveStatus('')
    try {
      const response = await fetch('/api/hermes/memories/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, name: pendingDelete }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(firstString(asRecord(payload).error) || `Failed to delete ${pendingDelete}`)
      }
      setMemories((current) => current.filter((m) => m.name !== pendingDelete))
      if (selected === pendingDelete) {
        setSelected('')
        setContent('')
      }
      setSaveStatus(`Deleted ${pendingDelete}.`)
    } catch (error) {
      setSaveStatus(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setDeleteBusy(false)
      setPendingDelete(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
        <p className="font-medium">Memory is last-writer-wins across concurrent runs.</p>
        <p className="mt-1 text-amber-800/80 dark:text-amber-300/80">
          Hermes stores {agent.name}&apos;s memory as a whole file it rewrites on every save. If two runs of this
          agent are active at once, the run that finishes last overwrites whatever the other one just learned — there
          is no merge. &ldquo;Which run learned this entry&rdquo; is also not tracked anywhere today, so entries below
          don&apos;t show a source run unless Hermes itself reports one.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Memory entries</h3>
        </div>
        <p className="mb-3 text-xs text-black/50 dark:text-white/50">
          Real files under {agent.name}&apos;s Hermes profile — what this agent has learned across runs.
        </p>

        {listError && <p className="mb-2 text-xs text-red-600">{listError}</p>}
        {loading ? (
          <p className="text-xs text-black/50 dark:text-white/50">Loading memories…</p>
        ) : memories.length === 0 ? (
          <div className="rounded-md border border-dashed border-black/15 px-3 py-3 text-xs text-black/50 dark:border-white/15 dark:text-white/50">
            No memory entries yet for {agent.name}. Nothing has been learned, or Hermes hasn&apos;t reported any —
            this list reflects whatever the memories proxy returns.
          </div>
        ) : (
          <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
            {memories.map((memory) => {
              const infoBits = [
                formatBytes(memory.size),
                memory.modifiedAt ? new Date(memory.modifiedAt).toLocaleString() : null,
                memory.runId ? `run #${memory.runId}` : null,
              ].filter(Boolean)
              return (
                <div key={memory.name} className="rounded-md border border-black/10 p-2 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(memory.name)
                      setPendingDelete(null)
                    }}
                    className="w-full text-left"
                  >
                    <p className="truncate text-sm font-medium">{memory.name}</p>
                    {memory.description && (
                      <p className="truncate text-xs text-black/50 dark:text-white/50">{memory.description}</p>
                    )}
                    {infoBits.length > 0 && (
                      <p className="mt-0.5 text-[11px] text-black/40 dark:text-white/40">{infoBits.join(' · ')}</p>
                    )}
                    {!memory.runId && (
                      <p className="mt-0.5 text-[11px] text-black/30 dark:text-white/30">Source run: unavailable</p>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-4 rounded-md border border-black/10 p-3 dark:border-white/10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium">Entry editor</h4>
            {selected ? <p className="text-[11px] text-black/50 dark:text-white/50">{selected}</p> : null}
          </div>

          {!selected ? (
            <p className="text-xs text-black/50 dark:text-white/50">Pick an entry above to read or edit it.</p>
          ) : (
            <>
              {contentError && <p className="mb-2 text-xs text-red-600">{contentError}</p>}
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={12}
                disabled={contentLoading}
                className="w-full rounded-md border border-black/15 bg-transparent px-2 py-2 font-mono text-xs dark:border-white/15"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button type="button" size="sm" onClick={() => void saveContent()} disabled={saveBusy || contentLoading}>
                  {saveBusy ? 'Saving…' : 'Save'}
                </Button>
                {pendingDelete === selected ? (
                  <>
                    <Button type="button" size="sm" variant="destructive" onClick={() => void confirmDelete()} disabled={deleteBusy}>
                      {deleteBusy ? 'Deleting…' : 'Confirm delete'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setPendingDelete(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button type="button" size="sm" variant="destructive" onClick={() => setPendingDelete(selected)}>
                    Delete?
                  </Button>
                )}
                {saveStatus && <p className="text-xs text-black/50 dark:text-white/50">{saveStatus}</p>}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
