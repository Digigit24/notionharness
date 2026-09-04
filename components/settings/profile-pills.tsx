'use client'

import { useRouter } from 'next/navigation'
import type { ServeProfile } from '@/lib/hermes/serve-client'

/**
 * The profile switcher every Hermes-backed settings section shares.
 *
 * It exists as its own component because "which profile am I editing" is the
 * single most important piece of context on these screens: the same page
 * shows different models, different skills and different MCP servers
 * depending on it, and getting it wrong means changing another agent's
 * behaviour by accident.
 */
export function ProfilePills({
  profiles,
  active,
  basePath,
}: {
  profiles: ServeProfile[]
  /** '' means the install root. */
  active: string
  /** e.g. `/workspace/acme/settings/skills` */
  basePath: string
}) {
  const router = useRouter()
  if (profiles.length === 0) return null

  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5">
      {profiles.map((entry) => {
        const key = entry.is_default ? '' : entry.name
        const isActive = key === active
        return (
          <button
            key={entry.name}
            type="button"
            onClick={() => router.push(key ? `${basePath}?profile=${encodeURIComponent(key)}` : basePath)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              isActive
                ? 'border-black/25 bg-black/[0.06] font-medium dark:border-white/25 dark:bg-white/[0.09]'
                : 'border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20'
            }`}
          >
            {entry.is_default ? 'Install default' : entry.name}
          </button>
        )
      })}
    </div>
  )
}
