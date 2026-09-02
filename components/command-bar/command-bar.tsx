'use client'

// B0: Frame — the ⌘K command bar. Built navigate mode (jump to any page,
// task, agent, or run) and act mode (create task / assign / start run /
// change status), with navigate mode's search backed by a swappable seam
// (`NAVIGATE_PROVIDERS` / `NAVIGATE_ITEM_BUILDERS` below).
//
// B-3 "Surface" (B1.3) filled that seam in with real Postgres full-text
// search (projects/comments/skills categories added too — see
// `components/command-bar/types.ts`'s `NAVIGATE_PROVIDERS` comment) and
// added the filter chips below it. The "ask → agent run" natural-language
// mode (B1.2/B3) is still not built here — see the SEAM comment in
// `./types.ts` for where it slots in later.
//
// This component owns the ⌘K hotkey entirely (its own `keydown` listener,
// not the shared keyboard-shortcut registry another parallel workstream is
// building — that registry has been told not to claim this key). It also
// listens for `COMMAND_BAR_OPEN_EVENT` (`lib/command-bar-bus.ts`) so other
// UI (today: the sidebar's Cmd+K hint button) can open it without lifting
// its open/closed state out of this component.

import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  BookOpen,
  Bot,
  FileText,
  Folder,
  ListTodo,
  MessageSquare,
  Play,
  Plus,
  Search,
  Sparkles,
  UserRoundPlus,
  Workflow,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { COMMAND_BAR_OPEN_EVENT } from '@/lib/command-bar-bus'
import { updateTaskFields } from '@/app/(app)/workspace/[workspaceSlug]/tasks/actions'
import {
  listAssignableUsers,
  listWorkspaceAgents,
  listWorkspaceProjects,
  listWorkspaceStatuses,
  quickCreateTask,
  searchCommandBar,
  searchTasksForPicker,
  type CommandBarSearchResult,
} from '@/app/(app)/workspace/[workspaceSlug]/command-bar/actions'
import { ACT_COMMANDS, NAVIGATE_PROVIDERS, type ActCommand, type NavigateProviderKey } from './types'
import type { Agent, Project, Task, TaskStatus, User, Workspace } from '@/payload-types'

const EMPTY_SEARCH: CommandBarSearchResult = {
  pages: [],
  tasks: [],
  projects: [],
  agents: [],
  comments: [],
  runs: [],
  skills: [],
}
// Already within the plan's 150-250ms guidance for debouncing full-text
// queries (more expensive than B0's `like` scans) — B0 had already tuned
// this value, so B-3 keeps it as-is rather than re-tuning something that
// already satisfies the requirement.
const SEARCH_DEBOUNCE_MS = 200

interface RowItem {
  key: string
  icon: ReactNode
  label: string
  sublabel?: string
  onSelect: () => void
}

interface Section {
  key: string
  label?: string
  emptyLabel?: string
  loading?: boolean
  items: RowItem[]
}

const ACTION_ICONS: Record<ActCommand['key'], ReactNode> = {
  'create-task': <Plus size={14} />,
  assign: <UserRoundPlus size={14} />,
  'start-run': <Play size={14} />,
  'change-status': <Workflow size={14} />,
}

/**
 * SEAM (B1.3): one builder per `NAVIGATE_PROVIDERS` entry — the category
 * *list* (order/labels/empty states) lives in `./types.ts`, this is just
 * "how to turn one category's slice of `CommandBarSearchResult` into rows."
 * Swapping a category's underlying search for real full-text search only
 * ever touches `searchCommandBar` (`.../command-bar/actions.ts`); this map
 * doesn't change.
 */
const NAVIGATE_ITEM_BUILDERS: Record<
  NavigateProviderKey['key'],
  (results: CommandBarSearchResult, goTo: (hrefTail: string) => void) => RowItem[]
> = {
  pages: (r, goTo) =>
    r.pages.map((p) => ({
      key: `page-${p.id}`,
      icon: <span>{p.icon || <FileText size={14} />}</span>,
      label: p.title || 'Untitled',
      onSelect: () => goTo(`p/${p.id}`),
    })),
  tasks: (r, goTo) =>
    r.tasks.map((t) => ({
      key: `task-${t.id}`,
      icon: <ListTodo size={14} />,
      label: t.title,
      onSelect: () => goTo(`tasks?task=${t.id}`),
    })),
  projects: (r, goTo) =>
    r.projects.map((p) => ({
      key: `project-${p.id}`,
      icon: <span>{p.icon || <Folder size={14} />}</span>,
      label: p.name,
      onSelect: () => goTo(`projects/${p.id}`),
    })),
  agents: (r, goTo) =>
    r.agents.map((a) => ({
      key: `agent-${a.id}`,
      icon: <Bot size={14} />,
      label: a.name,
      // No per-agent detail route exists in this app yet (only a
      // workspace-wide agents list) — land on the list rather than
      // inventing a fake `/agents/[id]` URL.
      onSelect: () => goTo('agents'),
    })),
  comments: (r, goTo) =>
    r.comments.map((c) => ({
      key: `comment-${c.id}`,
      icon: <MessageSquare size={14} />,
      // Comments have no page of their own — land on the parent task,
      // same pattern runs use for their review page.
      label: c.body.length > 96 ? `${c.body.slice(0, 96)}…` : c.body,
      sublabel: c.taskTitle,
      onSelect: () => goTo(`tasks?task=${c.taskId}`),
    })),
  runs: (r, goTo) =>
    r.runs.map((run) => ({
      key: `run-${run.id}`,
      icon: <Play size={14} />,
      label: `Run #${run.id}`,
      sublabel: run.taskTitle ? `${run.status} · ${run.taskTitle}` : run.status,
      onSelect: () => goTo(`runs/${run.id}/review`),
    })),
  skills: (r, goTo) =>
    r.skills.map((s) => ({
      key: `skill-${s.name}`,
      icon: <BookOpen size={14} />,
      label: s.name,
      sublabel: s.description || undefined,
      // No global "skills" page exists in this app — same honest fallback
      // the `agents` builder above already uses for the same reason.
      onSelect: () => goTo('agents'),
    })),
}

export function CommandBar({
  workspace,
  currentUserId,
}: {
  workspace: Workspace
  currentUserId: number | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [actStep, setActStep] = useState<ActCommand['key'] | null>(null)
  const [actTask, setActTask] = useState<Task | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pending, startTransition] = useTransition()

  // Navigate-mode results.
  const [navResults, setNavResults] = useState<CommandBarSearchResult>(EMPTY_SEARCH)
  const [navLoading, setNavLoading] = useState(false)
  // Filters by type (B-3): `null` means "all" (every category except
  // `skills` — see NAVIGATE_PROVIDERS' own comment on why skills stays
  // out of the default hot path). Selecting a chip narrows both which
  // sections render and which categories `searchCommandBar` actually
  // queries, which is also the only way `skills` ever gets queried.
  const [navFilter, setNavFilter] = useState<NavigateProviderKey['key'] | null>(null)

  // Act-mode pickers — fetched lazily per step, not on mount, so a
  // component mounted on every page (it lives in the sidebar) never fetches
  // data nobody asked for.
  const [taskPickerResults, setTaskPickerResults] = useState<Task[]>([])
  const [taskPickerLoading, setTaskPickerLoading] = useState(false)
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [users, setUsers] = useState<User[] | null>(null)
  const [statuses, setStatuses] = useState<TaskStatus[] | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)

  // Create-task inline form.
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskProjectId, setNewTaskProjectId] = useState<number | ''>('')

  const mode: 'navigate' | 'act' = actStep === null ? 'navigate' : 'act'

  function resetAll() {
    setQuery('')
    setActStep(null)
    setActTask(null)
    setActiveIndex(0)
    setNavResults(EMPTY_SEARCH)
    setNavFilter(null)
    setTaskPickerResults([])
    setNewTaskTitle('')
    setNewTaskProjectId('')
  }

  useEffect(() => {
    if (!open) resetAll()
  }, [open])

  // Own the ⌘K hotkey entirely — no shared shortcut registry involved.
  // Opens from inside almost any input/textarea (normal command-palette
  // behavior) but NOT from inside BlockSuite's own contenteditable: its
  // wrapper (`components/editor/BlockSuiteEditor.tsx`) marks its mount
  // point with the `blocksuite-editor-root` class, and BlockSuite may bind
  // its own meaning to Cmd+K inside the editor — this yields to it there.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      const target = e.target as HTMLElement | null
      if (target?.closest('.blocksuite-editor-root')) return
      e.preventDefault()
      setOpen((prev) => !prev)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The one sanctioned way for other UI (the sidebar's hint button today)
  // to ask this component to open — see lib/command-bar-bus.ts.
  useEffect(() => {
    function onExternalOpen() {
      setOpen(true)
    }
    window.addEventListener(COMMAND_BAR_OPEN_EVENT, onExternalOpen)
    return () => window.removeEventListener(COMMAND_BAR_OPEN_EVENT, onExternalOpen)
  }, [])

  // Navigate-mode search (debounced).
  useEffect(() => {
    if (mode !== 'navigate') return
    const q = query.trim()
    if (!q) {
      setNavResults(EMPTY_SEARCH)
      setNavLoading(false)
      return
    }
    setNavLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      searchCommandBar({ workspaceId: workspace.id, query: q, types: navFilter ? [navFilter] : undefined }).then((res) => {
        if (!cancelled) {
          setNavResults(res)
          setNavLoading(false)
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, mode, workspace.id, navFilter])

  // Act-mode step 1: task picker (Assign / Start run / Change status all begin with "which task").
  const needsTaskPicker = mode === 'act' && actStep !== 'create-task' && actTask === null
  useEffect(() => {
    if (!needsTaskPicker) return
    setTaskPickerLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      searchTasksForPicker(workspace.id, query.trim()).then((docs) => {
        if (!cancelled) {
          setTaskPickerResults(docs)
          setTaskPickerLoading(false)
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needsTaskPicker, query, workspace.id])

  // Act-mode step 2 pickers — fetched once per step-entry, then filtered client-side as the user types.
  useEffect(() => {
    if (actStep === 'start-run' && actTask && agents === null) {
      listWorkspaceAgents(workspace.id).then(setAgents)
    }
    if (actStep === 'assign' && actTask && users === null) {
      listAssignableUsers(workspace.id).then(setUsers)
    }
    if (actStep === 'change-status' && actTask && statuses === null) {
      listWorkspaceStatuses(workspace.id).then(setStatuses)
    }
    if (actStep === 'create-task') {
      if (statuses === null) listWorkspaceStatuses(workspace.id).then(setStatuses)
      if (projects === null) listWorkspaceProjects(workspace.id).then(setProjects)
    }
  }, [actStep, actTask, agents, users, statuses, projects, workspace.id])

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ACT_COMMANDS
    return ACT_COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q) || q.includes(k)),
    )
  }, [query])

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = agents ?? []
    return q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list
  }, [agents, query])

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = users ?? []
    return q ? list.filter((u) => (u.name || u.email).toLowerCase().includes(q)) : list
  }, [users, query])

  const filteredStatuses = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = statuses ?? []
    return q ? list.filter((s) => s.name.toLowerCase().includes(q)) : list
  }, [statuses, query])

  const defaultStatusId = useMemo(() => {
    if (!statuses || statuses.length === 0) return null
    const todo = statuses.find((s) => s.category === 'todo')
    const backlog = statuses.find((s) => s.category === 'backlog')
    return (todo ?? backlog ?? statuses[0]).id
  }, [statuses])

  const goTo = useCallback(
    (hrefTail: string) => {
      setOpen(false)
      router.push(`/workspace/${workspace.slug}/${hrefTail}`)
    },
    [router, workspace.slug],
  )

  function enterAct(cmd: ActCommand) {
    setActStep(cmd.key)
    setActTask(null)
    setQuery('')
    setActiveIndex(0)
  }

  function goBack() {
    if (actTask) {
      setActTask(null)
      setQuery('')
      setActiveIndex(0)
      return
    }
    setActStep(null)
    setQuery('')
    setActiveIndex(0)
  }

  function pickTask(task: Task) {
    setActTask(task)
    setQuery('')
    setActiveIndex(0)
  }

  const doAssign = useCallback(
    (user: User) => {
      if (!actTask) return
      startTransition(async () => {
        await updateTaskFields({ taskId: actTask.id, workspaceSlug: workspace.slug, data: { assignee: user.id } })
        setOpen(false)
        router.push(`/workspace/${workspace.slug}/tasks?task=${actTask.id}`)
        router.refresh()
      })
    },
    [actTask, router, workspace.slug],
  )

  const doStartRun = useCallback(
    (agent: Agent) => {
      if (!actTask) return
      startTransition(async () => {
        // `updateTaskFields` is the one real path that enqueues a run —
        // see its own body: setting `agent` on a task triggers
        // `enqueueRun` internally when the agent actually changes. There
        // is no separate "start run" backend action in this codebase;
        // this reuses the same call the task drawer's own agent picker
        // makes.
        await updateTaskFields({ taskId: actTask.id, workspaceSlug: workspace.slug, data: { agent: agent.id } })
        setOpen(false)
        router.push(`/workspace/${workspace.slug}/tasks?task=${actTask.id}`)
        router.refresh()
      })
    },
    [actTask, router, workspace.slug],
  )

  const doChangeStatus = useCallback(
    (status: TaskStatus) => {
      if (!actTask) return
      startTransition(async () => {
        await updateTaskFields({ taskId: actTask.id, workspaceSlug: workspace.slug, data: { status: status.id } })
        setOpen(false)
        router.push(`/workspace/${workspace.slug}/tasks?task=${actTask.id}`)
        router.refresh()
      })
    },
    [actTask, router, workspace.slug],
  )

  function doCreateTask() {
    const title = newTaskTitle.trim()
    if (!title || !currentUserId || defaultStatusId === null) return
    startTransition(async () => {
      const task = await quickCreateTask({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        statusId: defaultStatusId,
        title,
        createdById: currentUserId,
        projectId: newTaskProjectId === '' ? null : newTaskProjectId,
      })
      setOpen(false)
      router.push(`/workspace/${workspace.slug}/tasks?task=${task.id}`)
      router.refresh()
    })
  }

  // --- Section list for the currently visible step, and a flattened copy for keyboard nav. ---
  const sections: Section[] = useMemo(() => {
    if (mode === 'navigate') {
      const list: Section[] = [
        {
          key: 'actions',
          label: 'Actions',
          items: filteredActions.map((cmd) => ({
            key: `action-${cmd.key}`,
            icon: ACTION_ICONS[cmd.key],
            label: cmd.label,
            sublabel: cmd.description,
            onSelect: () => enterAct(cmd),
          })),
        },
      ]
      if (query.trim() !== '') {
        // Filter chips (B-3): a selected `navFilter` shows only that one
        // category's section. Unfiltered, every category except `skills`
        // shows — `skills` only ever appears once the user filters to it
        // (see NAVIGATE_PROVIDERS' comment for why).
        const visibleProviders = navFilter
          ? NAVIGATE_PROVIDERS.filter((p) => p.key === navFilter)
          : NAVIGATE_PROVIDERS.filter((p) => p.key !== 'skills')
        list.push(
          ...visibleProviders.map((provider) => ({
            key: provider.key,
            label: provider.label,
            emptyLabel: provider.emptyLabel,
            loading: navLoading,
            items: NAVIGATE_ITEM_BUILDERS[provider.key](navResults, goTo),
          })),
        )
      }
      return list
    }

    // Act mode.
    if (actStep === 'create-task') {
      return []
    }

    if (actTask === null) {
      return [
        {
          key: 'task-picker',
          label: 'Select a task',
          emptyLabel: 'No matching tasks',
          loading: taskPickerLoading,
          items: taskPickerResults.map((t) => ({
            key: `pick-task-${t.id}`,
            icon: <ListTodo size={14} />,
            label: t.title,
            onSelect: () => pickTask(t),
          })),
        },
      ]
    }

    if (actStep === 'assign') {
      return [
        {
          key: 'user-picker',
          label: `Assign "${actTask.title}" to`,
          emptyLabel: users === null ? 'Loading...' : 'No workspace members found',
          items: filteredUsers.map((u) => ({
            key: `pick-user-${u.id}`,
            icon: <UserRoundPlus size={14} />,
            label: u.name || u.email,
            sublabel: u.name ? u.email : undefined,
            onSelect: () => doAssign(u),
          })),
        },
      ]
    }

    if (actStep === 'start-run') {
      return [
        {
          key: 'agent-picker',
          label: `Start a run on "${actTask.title}" with`,
          emptyLabel: agents === null ? 'Loading...' : 'No enabled agents in this workspace',
          items: filteredAgents.map((a) => ({
            key: `pick-agent-${a.id}`,
            icon: <Bot size={14} />,
            label: a.name,
            onSelect: () => doStartRun(a),
          })),
        },
      ]
    }

    // change-status
    return [
      {
        key: 'status-picker',
        label: `Move "${actTask.title}" to`,
        emptyLabel: statuses === null ? 'Loading...' : 'No statuses configured for this workspace',
        items: filteredStatuses.map((s) => ({
          key: `pick-status-${s.id}`,
          icon: <Workflow size={14} />,
          label: s.name,
          onSelect: () => doChangeStatus(s),
        })),
      },
    ]
  }, [
    mode,
    actStep,
    actTask,
    query,
    filteredActions,
    navResults,
    navLoading,
    navFilter,
    taskPickerResults,
    taskPickerLoading,
    filteredAgents,
    filteredUsers,
    filteredStatuses,
    agents,
    users,
    statuses,
    goTo,
    doAssign,
    doStartRun,
    doChangeStatus,
  ])

  const flatRows = useMemo(() => sections.flatMap((s) => s.items), [sections])

  useEffect(() => {
    setActiveIndex(0)
  }, [flatRows.length])

  function onHeaderKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (actStep === 'create-task') {
      if (e.key === 'Enter') doCreateTask()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, Math.max(flatRows.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatRows[activeIndex]?.onSelect()
    } else if (e.key === 'Backspace' && query === '' && mode === 'act') {
      goBack()
    }
  }

  const headerValue = actStep === 'create-task' ? newTaskTitle : query
  const headerOnChange = actStep === 'create-task' ? setNewTaskTitle : setQuery
  const headerPlaceholder =
    actStep === 'create-task'
      ? 'Task title'
      : mode === 'navigate'
        ? `Search ${workspace.name}, or run a command...`
        : needsTaskPicker
          ? 'Search tasks...'
          : 'Filter...'

  const breadcrumbLabel =
    mode === 'act'
      ? [ACT_COMMANDS.find((c) => c.key === actStep)?.label, actTask?.title].filter(Boolean).join(' · ')
      : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[15vh] max-w-lg translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-lg"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2.5 dark:border-white/10">
            {mode === 'act' && (
              <button
                type="button"
                onClick={goBack}
                title="Back"
                aria-label="Back"
                className="shrink-0 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
              >
                <ArrowLeft size={15} />
              </button>
            )}
            {mode === 'navigate' && <Search size={15} className="shrink-0 text-black/40 dark:text-white/40" />}
            <Input
              autoFocus
              value={headerValue}
              onChange={(e) => headerOnChange(e.target.value)}
              onKeyDown={onHeaderKeyDown}
              placeholder={headerPlaceholder}
              className="h-auto flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            />
            <kbd className="shrink-0 rounded border border-black/10 px-1 text-[10px] text-black/40 dark:border-white/10 dark:text-white/40">
              Esc
            </kbd>
          </div>

          {mode === 'navigate' && query.trim() !== '' && (
            <div className="flex flex-wrap gap-1 border-b border-black/5 px-3 py-1.5 dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  setNavFilter(null)
                  setActiveIndex(0)
                }}
                aria-pressed={navFilter === null}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs',
                  navFilter === null
                    ? 'bg-black/[.08] text-black dark:bg-white/[.12] dark:text-white'
                    : 'text-black/50 hover:bg-black/[.05] dark:text-white/50 dark:hover:bg-white/[.06]',
                )}
              >
                All
              </button>
              {NAVIGATE_PROVIDERS.map((provider) => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => {
                    setNavFilter((current) => (current === provider.key ? null : provider.key))
                    setActiveIndex(0)
                  }}
                  aria-pressed={navFilter === provider.key}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs',
                    navFilter === provider.key
                      ? 'bg-black/[.08] text-black dark:bg-white/[.12] dark:text-white'
                      : 'text-black/50 hover:bg-black/[.05] dark:text-white/50 dark:hover:bg-white/[.06]',
                  )}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          )}

          {breadcrumbLabel && (
            <div className="border-b border-black/5 px-3 py-1.5 text-xs text-black/40 dark:border-white/10 dark:text-white/40">
              {breadcrumbLabel}
            </div>
          )}

          {actStep === 'create-task' ? (
            <div className="flex flex-col gap-3 p-3">
              <div>
                <label className="mb-1 block text-xs text-black/40 dark:text-white/40">Project (optional)</label>
                <select
                  value={newTaskProjectId}
                  onChange={(e) => setNewTaskProjectId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full rounded-md border border-black/10 bg-transparent px-2.5 py-1.5 text-sm dark:border-white/10"
                >
                  <option value="">No project</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              {!currentUserId && (
                <p className="text-xs text-red-500">Couldn&apos;t identify the current user — can&apos;t create a task.</p>
              )}
              {currentUserId && defaultStatusId === null && statuses !== null && (
                <p className="text-xs text-red-500">This workspace has no task statuses configured yet.</p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={goBack}>
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={!newTaskTitle.trim() || !currentUserId || defaultStatusId === null || pending}
                  onClick={doCreateTask}
                >
                  Create task
                </Button>
              </div>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto p-1.5">
              {sections.map((section) => (
                <div key={section.key} className="mb-2 last:mb-0">
                  {section.label && (
                    <p className="px-2.5 py-1 text-xs font-medium text-black/40 dark:text-white/40">{section.label}</p>
                  )}
                  {section.items.length === 0 && section.emptyLabel && (
                    <p className="px-2.5 py-2 text-sm text-black/40 dark:text-white/40">{section.emptyLabel}</p>
                  )}
                  {section.items.map((item) => {
                    const idx = flatRows.indexOf(item)
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={item.onSelect}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm',
                          idx === activeIndex
                            ? 'bg-black/[.06] dark:bg-white/[.08]'
                            : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]',
                        )}
                      >
                        <span className="shrink-0 text-black/40 dark:text-white/40">{item.icon}</span>
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.sublabel && (
                          <span className="shrink-0 truncate text-xs text-black/40 dark:text-white/40">
                            {item.sublabel}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
              {mode === 'navigate' && query.trim() === '' && (
                <p className="flex items-center gap-1.5 px-2.5 pt-2 text-xs text-black/40 dark:text-white/40">
                  <Sparkles size={12} />
                  Ask (natural language → agent run) lands in a later batch.
                </p>
              )}
            </div>
          )}
        </DialogContent>
    </Dialog>
  )
}
