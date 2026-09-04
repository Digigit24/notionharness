'use client'

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
  Server,
  Settings2,
  Sparkles,
  UserCog,
  Wrench,
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
 * Grouped the way the questions are actually asked: what answers (models,
 * providers, profiles), what it can do (skills, connectors, runtimes), what
 * it is allowed to do (safety), and how it is behaving (health, audit).
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
}

const GROUPS: RailGroup[] = [
  {
    title: 'Workspace',
    items: [
      { segment: '', label: 'General', icon: Settings2, hint: 'Spend cap' },
      // Per-user and cross-workspace by design, so it lives outside the
      // workspace segment — but it was in no navigation at all, which its own
      // header comment had been asking someone to fix.
      { segment: 'notifications', label: 'Notifications', icon: Bell, hint: 'Per-user, all workspaces' },
    ],
  },
  {
    title: 'Model',
    items: [
      { segment: 'model', label: 'Model & fallbacks', icon: Cpu, hint: 'Active model, priority order' },
      { segment: 'providers', label: 'Providers', icon: KeyRound, hint: 'Keys and endpoints' },
      { segment: 'personality', label: 'Profiles', icon: Sparkles, hint: 'Hermes identities' },
    ],
  },
  {
    title: 'Capabilities',
    items: [
      { segment: 'skills', label: 'Skills', icon: Wrench, hint: 'Enable, edit, install' },
      { segment: 'mcp', label: 'MCP servers', icon: Blocks, hint: 'Connected tool servers' },
      { segment: 'mcp-catalog', label: 'MCP catalog', icon: Blocks, hint: 'Browse available presets' },
      { segment: 'runtimes', label: 'Runtimes', icon: Server, hint: 'Agent binaries' },
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

export function SettingsRail({ workspaceSlug }: { workspaceSlug: string }) {
  const pathname = usePathname()
  const base = `/workspace/${workspaceSlug}/settings`

  return (
    <nav className="w-56 shrink-0 border-r border-black/10 px-2 py-4 dark:border-white/10">
      <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
        <Gauge size={12} className="mr-1 inline" />
        Settings
      </h2>
      {GROUPS.map((group) => (
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
