import { AlertTriangle } from 'lucide-react'

/**
 * Phase C, C1.5 — the first-run gate the roadmap doc asks for: "if no
 * Hermes is configured, the app says so plainly ... rather than failing
 * per-request deep in a route." Every Hermes-backed feature (agents,
 * skills, MCP, models, crons) currently fails its own way, deep in its own
 * route, the moment `HERMES_API_BASE_URL` is unset — this banner is the one
 * place that says it plainly, once, before anyone goes looking.
 *
 * Deliberately a server component with no dismiss/retry state: whether
 * Hermes is configured is a deploy-time fact (an env var), not something
 * that changes while a page is open, unlike `ConnectionStatusBanner`'s
 * live, retryable SSE drop. It stays until the var is actually set and the
 * app restarts — once C2 lands DB-backed Hermes connection settings with a
 * real Test Connection button, this becomes a link to that field instead
 * of an env-var instruction (see AGENTS.md's Phase C notes for why that
 * part is schema-gated, not skipped).
 */
export function HermesNotConfiguredBanner() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400">
      <AlertTriangle size={12} className="shrink-0" />
      <span>
        Hermes isn&apos;t configured — set <code className="font-mono">HERMES_API_BASE_URL</code> (and{' '}
        <code className="font-mono">HERMES_HOME_BASE</code>) and restart. Agents, skills, MCP, and models won&apos;t
        work until then.
      </span>
    </div>
  )
}
