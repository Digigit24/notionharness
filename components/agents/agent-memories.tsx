'use client'

import { useEffect, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Brain, Loader2, Pencil, Plus, Trash2, User, X } from 'lucide-react'
import type { Agent } from '@/components/agents/agent-editor'
import {
  addAgentMemory,
  deleteAgentMemory,
  getAgentMemory,
  updateAgentMemory,
} from '@/app/(app)/workspace/[workspaceSlug]/agents/actions'
import type { AgentMemory, AgentMemoryFile, MemoryTarget } from '@/lib/hermes/agent-memory'
import { formatCount } from '@/lib/relative-time'

/**
 * What an agent remembers, as Hermes actually stores it.
 *
 * This replaces a version that fetched `/api/hermes/memories?profile=<agent
 * name>` and always failed: that endpoint does not exist on any Hermes
 * server, and memory is keyed by numeric agent id, not profile name. It now
 * reads and writes the real files through server actions — see
 * `lib/hermes/agent-memory.ts`.
 *
 * The shape follows Hermes's own model rather than inventing one: two files,
 * MEMORY.md (what the agent noted) and USER.md (who you are), each a list of
 * `§`-separated entries. An edit here is visible to the agent on its next
 * turn, and anything the agent writes with its own memory tool shows up here.
 */
const TARGETS: Array<{
  key: MemoryTarget
  label: string
  hint: string
  icon: typeof Brain
}> = [
  {
    key: 'memory',
    label: 'Agent notes',
    hint: 'What this agent has chosen to remember across runs. Written by its own memory tool.',
    icon: Brain,
  },
  {
    key: 'user',
    label: 'User profile',
    hint: 'What this agent knows about you. Kept separate so notes and identity never overwrite each other.',
    icon: User,
  },
]

export function AgentMemories({ agent }: { agent: Agent }) {
  const agentId = agent.id
  const [memory, setMemory] = useState<AgentMemory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getAgentMemory(agentId)
      .then((data) => {
        if (!cancelled) setMemory(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read this agent’s memory.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const applyFile = (target: MemoryTarget, file: AgentMemoryFile) => {
    setMemory((current) => (current ? { ...current, [target]: file } : current))
  }

  return (
    <section className="rounded-lg border border-black/10 dark:border-white/10">
      <header className="border-b border-black/10 px-4 py-3 dark:border-white/10">
        <h2 className="text-sm font-semibold">Memory</h2>
        <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">
          Stored on this machine, one store per agent, shared by every run of this agent.
        </p>
      </header>

      {loading && (
        <p className="flex items-center gap-2 px-4 py-6 text-xs text-black/50 dark:text-white/50">
          <Loader2 size={13} className="animate-spin" />
          Reading memory…
        </p>
      )}

      {error && !loading && <p className="px-4 py-6 text-xs text-destructive">{error}</p>}

      {memory && !loading && !error && (
        <div className="divide-y divide-black/10 dark:divide-white/10">
          {TARGETS.map((target) => (
            <MemoryFileBlock
              key={target.key}
              agentId={agentId}
              meta={target}
              file={target.key === 'memory' ? memory.memory : memory.user}
              onChange={(file) => applyFile(target.key, file)}
            />
          ))}
          <p className="px-4 py-3 text-[11px] text-black/40 dark:text-white/40">
            Two runs of this agent share one store, and Hermes rewrites each file whole, so a
            concurrent write can overwrite an edit made here. Files live in {memory.dir}.
          </p>
        </div>
      )}
    </section>
  )
}

function MemoryFileBlock({
  agentId,
  meta,
  file,
  onChange,
}: {
  agentId: number
  meta: { key: MemoryTarget; label: string; hint: string; icon: typeof Brain }
  file: AgentMemoryFile
  onChange: (file: AgentMemoryFile) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [actionError, setActionError] = useState('')
  const [busy, startTransition] = useTransition()
  const Icon = meta.icon

  const run = (work: () => Promise<AgentMemoryFile>, onDone?: () => void) => {
    setActionError('')
    startTransition(async () => {
      try {
        onChange(await work())
        onDone?.()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'That change could not be saved.')
      }
    })
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Icon size={13} className="text-black/40 dark:text-white/40" />
            {meta.label}
            <span className="font-normal text-black/40 dark:text-white/40">
              {file.entries.length === 0 ? 'empty' : `${formatCount(file.entries.length)} entries`}
            </span>
          </h3>
          <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">{meta.hint}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || adding}
          onClick={() => {
            setAdding(true)
            setDraft('')
          }}
        >
          <Plus size={12} />
          Add
        </Button>
      </div>

      {actionError && <p className="mt-2 text-xs text-destructive">{actionError}</p>}

      {adding && (
        <div className="mt-2 rounded-md border border-black/10 p-2 dark:border-white/10">
          <textarea
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="One fact, in the agent’s own words…"
            className="w-full resize-y rounded bg-transparent text-xs outline-none"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={() => run(() => addAgentMemory(agentId, meta.key, draft), () => setAdding(false))}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}

      {file.entries.length === 0 && !adding && (
        <p className="mt-2 text-xs text-black/40 dark:text-white/40">
          Nothing yet. {meta.key === 'memory' ? 'This agent has not written any notes.' : 'No profile facts recorded.'}
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {file.entries.map((entry) => (
          <li
            key={entry.index}
            className="group rounded-md border border-black/10 px-2.5 py-2 text-xs dark:border-white/10"
          >
            {editingIndex === entry.index ? (
              <>
                <textarea
                  autoFocus
                  rows={3}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  className="w-full resize-y rounded bg-transparent outline-none"
                />
                <div className="mt-1 flex justify-end gap-1.5">
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditingIndex(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !editDraft.trim()}
                    onClick={() =>
                      run(
                        () => updateAgentMemory(agentId, meta.key, entry.index, editDraft),
                        () => setEditingIndex(null),
                      )
                    }
                  >
                    Save
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 whitespace-pre-wrap break-words">{entry.text}</p>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    aria-label="Edit entry"
                    className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                    onClick={() => {
                      setEditingIndex(entry.index)
                      setEditDraft(entry.text)
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  {pendingDelete === entry.index ? (
                    <>
                      <button
                        type="button"
                        className="rounded px-1.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => deleteAgentMemory(agentId, meta.key, entry.index),
                            () => setPendingDelete(null),
                          )
                        }
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel delete"
                        className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                        onClick={() => setPendingDelete(null)}
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label="Delete entry"
                      className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                      onClick={() => setPendingDelete(entry.index)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
