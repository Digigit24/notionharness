'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Bell,
  Blocks,
  Cpu,
  Gauge,
  History,
  KeyRound,
  Plug,
  Puzzle,
  Search,
  Server,
  Settings2,
  Sparkles,
  UserCog,
  Users,
  Wrench,
  X,
} from 'lucide-react'

/**
 * The settings sub-sidebar.
 *
 * These were separate top-level routes reachable only through a page of link
 * cards, so every one of them was a full-page navigation away from the last —
 * two clicks and a context switch to compare a model with the profile that
 * pins it. They are now child routes of `/settings`, which means this rail
 * stays mounted while the panel beside it swaps: it behaves as tabs, and each
 * section keeps its own URL (so it is linkable and the back button works).
 *
 * Grouped the way the questions are actually asked: what runs agents and what
 * they can reach (runtimes, providers, plugins), what a specific runtime needs
 * that nothing else does (the Hermes group, shown only when a Hermes runtime
 * is enabled here), what agents are allowed to do (safety), and how things are
 * behaving (health, audit).
 *
 * The Hermes group is not tidiness. Those screens edit a Hermes install: a
 * profile is a whole alternate HERMES_HOME, the skill editor writes files into
 * it, the MCP screens edit its `config.yaml`. In a workspace running only
 * Claude Code they would be controls that write nowhere.
 */
interface RailItem {
  segment: string
  label: string
  icon: LucideIcon
  hint?: string
}

interface RailGroup {
  title: string
  items: RailItem[]
  /**
   * Shown only when this workspace has an enabled Hermes runtime.
   *
   * Some screens here are not "settings that happen to be implemented against
   * Hermes" — they are Hermes features with no equivalent anywhere else. A
   * Hermes profile is a whole alternate HERMES_HOME; the skill editor writes
   * files into it; the MCP screens edit Hermes's own `config.yaml`. Offering
   * them to a workspace running only Claude Code would be offering controls
   * that write nowhere, which is worse than not offering them at all.
   */
  hermesOnly?: boolean
}

const GROUPS: RailGroup[] = [
  {
    title: 'Workspace',
    items: [
      { segment: '', label: 'General', icon: Settings2, hint: 'Spend cap' },
      // People management sits in Workspace rather than under Control: "who is
      // in this workspace" is a property of the workspace itself, asked long
      // before anybody asks how the queue is behaving.
      { segment: 'members', label: 'Members', icon: Users, hint: 'Roles, invitations' },
      // Per-user and cross-workspace by design, so it lives outside the
      // workspace segment — but it was in no navigation at all, which its own
      // header comment had been asking someone to fix.
      { segment: 'notifications', label: 'Notifications', icon: Bell, hint: 'Per-user, all workspaces' },
    ],
  },
  {
    title: 'Capabilities',
    items: [
      { segment: 'runtimes', label: 'Runtimes', icon: Server, hint: 'Agent binaries' },
      // Runtime-aware: it tabs per runtime and shows each one's own models, so
      // it belongs to every workspace rather than to the Hermes group below.
      { segment: 'providers', label: 'Providers', icon: KeyRound, hint: 'Where each runtime gets its model' },
      { segment: 'plugins', label: 'Plugins', icon: Puzzle, hint: 'Our tools, scoped per agent' },
      // Connectors sit beside Plugins rather than under Control because they
      // answer the same question — what can an agent reach — and differ only in
      // whose credential it reaches with. A plugin is a tool surface we own; a
      // connector is a third-party identity a PERSON authorised.
      { segment: 'connectors', label: 'Connectors', icon: Plug, hint: 'Third-party apps, per person' },
    ],
  },
  {
    title: 'Hermes',
    hermesOnly: true,
    items: [
      { segment: 'model', label: 'Model & fallbacks', icon: Cpu, hint: 'Active model, priority order' },
      { segment: 'personality', label: 'Profiles', icon: Sparkles, hint: 'Hermes identities' },
      { segment: 'skills', label: 'Skills', icon: Wrench, hint: 'Enable, edit, install' },
      { segment: 'mcp', label: 'MCP servers', icon: Blocks, hint: "Hermes's own config" },
      { segment: 'mcp-catalog', label: 'MCP catalog', icon: Blocks, hint: 'Browse available presets' },
    ],
  },
  {
    title: 'Control',
    items: [
      { segment: 'safety', label: 'Safety & memory', icon: UserCog, hint: 'Approvals, memory limits' },
      { segment: 'health', label: 'Health', icon: Activity, hint: 'Queue, latency, spend' },
      { segment: 'audit', label: 'Audit', icon: History, hint: 'Every run' },
    ],
  },
]

export function SettingsRail({
  workspaceSlug,
  hasHermesRuntime,
}: {
  workspaceSlug: string
  /** Whether this workspace has an enabled runtime that uses the Hermes home
   * strategy. Decided on the server, because it is a database question. */
  hasHermesRuntime: boolean
}) {
  const pathname = usePathname()
  const base = `/workspace/${workspaceSlug}/settings`
  const [query, setQuery] = useState('')

  // R12-P4.6 — fifteen items across four groups is past the point where
  // scanning the list beats typing a few letters of what you want. Filtered
  // client-side against data already in memory: every label, hint and group
  // title lives in the `GROUPS` array above, so this is a pure array filter
  // with nothing to fetch and nothing D0 would object to.
  const groups = useMemo(() => {
    const visible = GROUPS.filter((group) => !group.hermesOnly || hasHermesRuntime)
    const needle = query.trim().toLowerCase()
    if (!needle) return visible
    return visible
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.label.toLowerCase().includes(needle) ||
            item.hint?.toLowerCase().includes(needle) ||
            group.title.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0)
  }, [hasHermesRuntime, query])

  return (
    <nav className="w-56 shrink-0 border-r border-black/10 px-2 py-4 dark:border-white/10">
      <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
        <Gauge size={12} className="mr-1 inline" />
        Settings
      </h2>

      <div className="relative mb-3 px-1">
        <Search size={12} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-black/30 dark:text-white/30" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full rounded-md border border-black/10 bg-transparent py-1.5 pl-8 pr-7 text-xs outline-none placeholder:text-black/30 focus:border-black/25 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/25"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-black/30 hover:bg-black/[0.06] hover:text-black/60 dark:text-white/30 dark:hover:bg-white/[0.09] dark:hover:text-white/60"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {query && groups.length === 0 && (
        <p className="px-2 py-1 text-xs text-black/40 dark:text-white/40">Nothing matches &ldquo;{query}&rdquo;.</p>
      )}

      {groups.map((group) => (
        <section key={group.title} className="mb-3">
          <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-black/30 dark:text-white/30">
            {group.title}
          </h3>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              // Two items live outside this settings segment and need their
              // real paths: Audit is a workspace view in its own right, and
              // Notifications is deliberately per-user and cross-workspace
              // (see its own page header), so it is not workspace-scoped at
              // all. Everything else is a child route of `base`.
              const href =
                item.segment === 'audit'
                  ? `/workspace/${workspaceSlug}/audit`
                  : item.segment === 'notifications'
                    ? '/settings/notifications'
                    : item.segment
                      ? `${base}/${item.segment}`
                      : base
              const active =
                item.segment === ''
                  ? pathname === base || pathname === `${base}/`
                  : pathname.startsWith(href)
              const Icon = item.icon
              return (
                <li key={item.label}>
                  <Link
                    href={href}
                    className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                      active
                        ? 'bg-black/[0.06] font-medium dark:bg-white/[0.09]'
                        : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    <Icon size={13} className="mt-0.5 shrink-0 text-black/40 dark:text-white/40" />
                    <span className="min-w-0">
                      <span className="block truncate">{item.label}</span>
                      {item.hint && (
                        <span className="block truncate text-[10px] text-black/35 dark:text-white/35">
                          {item.hint}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </nav>
  )
}
