'use client'

import Link from 'next/link'
import { Globe, Radio, Terminal } from 'lucide-react'

export interface AgentPluginRow {
  id: number
  name: string
  description: string | null
  transport: 'http' | 'sse' | 'stdio'
  /** Why this plugin will not load, if it will not. Computed server-side with
   * the same function the dispatcher uses, so this page and the run can never
   * disagree about whether a tool is usable. */
  problem: string | null
  /** True when it reaches this agent via the whole workspace rather than by
   * being named. Worth distinguishing: revoking it affects everyone. */
  viaWorkspace: boolean
}

const TRANSPORT_ICON = { http: Globe, sse: Radio, stdio: Terminal } as const

/**
 * R7.3 — what this agent can actually reach, read-only, with a way to change it.
 *
 * The Capabilities tab used to render Hermes skills and Hermes MCP servers for
 * every agent, which for an agent on any other runtime meant an empty panel
 * fetched from an install it has nothing to do with. What a non-Hermes agent
 * genuinely has is the plugins this workspace scopes to it, so that is what it
 * shows — read-only here, with a link to the screen that edits it, exactly as
 * this item asks.
 */
export function AgentPluginCapabilities({
  workspaceSlug,
  plugins,
  runtimeName,
}: {
  workspaceSlug: string
  plugins: AgentPluginRow[]
  runtimeName: string | null
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Tools</h3>
          <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">
            Plugins this workspace gives this agent, injected for the duration of each turn.
            {runtimeName ? ` Anything ${runtimeName} provides on its own is not listed here.` : ''}
          </p>
        </div>
        <Link
          href={`/workspace/${workspaceSlug}/settings/plugins`}
          className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Manage plugins →
        </Link>
      </div>

      {plugins.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">
          No plugins are scoped to this agent. It still has whatever tools its runtime provides.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {plugins.map((plugin) => {
            const Icon = TRANSPORT_ICON[plugin.transport]
            return (
              <li
                key={plugin.id}
                className="flex items-start gap-2.5 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10"
              >
                <Icon size={13} className="mt-0.5 shrink-0 text-black/35 dark:text-white/35" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{plugin.name}</span>
                    <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-black/50 dark:bg-white/[0.09] dark:text-white/50">
                      {plugin.transport}
                    </span>
                    {plugin.viaWorkspace && (
                      <span className="shrink-0 text-[10px] text-black/35 dark:text-white/35">
                        via workspace
                      </span>
                    )}
                  </div>
                  {plugin.description && (
                    <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{plugin.description}</p>
                  )}
                  {plugin.problem && (
                    <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                      Will not load: {plugin.problem}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
