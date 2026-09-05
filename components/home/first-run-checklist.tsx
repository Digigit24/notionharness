import Link from 'next/link'
import { CheckCircle2, Circle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

/**
 * ROADMAP B8.5 (Batch B-6 "Finish") — "Then a first-run checklist." Slotted
 * into the workspace home page (`page.tsx`) only when the workspace is
 * genuinely empty (see that file's own `isGenuinelyEmpty` check) — an
 * already-active workspace doesn't need to be told how to get started.
 *
 * Every step's `done` state is a real signal, not a guess:
 *   - "Connect a provider" — an *enabled* runtime profile exists for this
 *     workspace (`runtime-profiles.enabled = true`). A disabled one (e.g.
 *     the one `scripts/seed-starter-workspace.ts` seeds — see its own
 *     header comment for why it starts disabled) does not count as done.
 *   - "Create an agent" — an *enabled* agent exists.
 *   - "Run a task" — `hasAnyRunForWorkspace` (`lib/broker`) — any run ever,
 *     including still-queued, since this step is "you did the thing," not
 *     "it already finished."
 */
export interface FirstRunChecklistStatus {
  hasEnabledRuntimeProfile: boolean
  hasEnabledAgent: boolean
  hasAnyRun: boolean
}

export function FirstRunChecklist({
  workspaceSlug,
  status,
}: {
  workspaceSlug: string
  status: FirstRunChecklistStatus
}) {
  const steps = [
    {
      key: 'provider',
      label: 'Connect a provider',
      description: 'Add a runtime profile — Hermes, Claude Code, Codex or OpenCode — and enable it.',
      done: status.hasEnabledRuntimeProfile,
      href: `/workspace/${workspaceSlug}/settings/runtimes`,
    },
    {
      key: 'agent',
      label: 'Create an agent',
      description: 'Configure an agent against that runtime and turn it on.',
      done: status.hasEnabledAgent,
      href: `/workspace/${workspaceSlug}/agents`,
    },
    {
      key: 'run',
      label: 'Run a task',
      description: 'Create a task, assign it to your agent, and watch the run happen.',
      done: status.hasAnyRun,
      href: `/workspace/${workspaceSlug}/tasks`,
    },
  ]

  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-3">
        <p className="mb-1 text-sm font-medium">Get started</p>
        <ul className="flex flex-col gap-1">
          {steps.map((step) => (
            <li key={step.key}>
              <Link
                href={step.href}
                className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                <span aria-hidden="true" className={`mt-0.5 shrink-0 ${step.done ? 'text-emerald-600 dark:text-emerald-400' : 'text-black/25 dark:text-white/25'}`}>
                  {step.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={`text-sm font-medium ${step.done ? 'text-black/50 line-through dark:text-white/50' : ''}`}>
                    {step.label}
                  </span>
                  <span className="text-xs text-black/40 dark:text-white/40">{step.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
