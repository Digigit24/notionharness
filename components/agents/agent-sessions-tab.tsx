'use client'

import Link from 'next/link'
import { MessageSquare, Loader2 } from 'lucide-react'

import { formatRelativeTime } from '@/lib/relative-time'

export interface AgentSessionRow {
  id: number
  title: string | null
  projectName: string | null
  runCount: number
  isRunning: boolean
  preview: string | null
  lastActivityAt: string | null
}

/**
 * R7.3 — every conversation this agent has had.
 *
 * The agent detail page could say what an agent *is* and what it costs, but
 * not what it had actually been doing, which is usually the question someone
 * opens this page to answer. Each row links into the Work surface at that
 * session, so this is a way in rather than a read-only report.
 *
 * Deliberately not a second transcript viewer. The Work page already renders
 * a session properly — streaming, resume, approvals and all — and a
 * lighter-weight copy here would drift from it and be worse.
 */
export function AgentSessionsTab({
  workspaceSlug,
  sessions,
}: {
  workspaceSlug: string
  sessions: AgentSessionRow[]
}) {
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-black/50 dark:text-white/50">
        This agent has no conversations yet. Start one on the{' '}
        <Link
          href={`/workspace/${workspaceSlug}/work`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Work page
        </Link>
        .
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {sessions.map((session) => (
        <li key={session.id}>
          <Link
            href={`/workspace/${workspaceSlug}/work?session=${session.id}`}
            className="flex items-start gap-2.5 rounded-lg border border-black/10 px-3 py-2.5 transition hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.04]"
          >
            {session.isRunning ? (
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-primary" />
            ) : (
              <MessageSquare size={13} className="mt-0.5 shrink-0 text-black/35 dark:text-white/35" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">{session.title || 'Untitled conversation'}</span>
                {session.projectName && (
                  <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-black/50 dark:bg-white/[0.09] dark:text-white/50">
                    {session.projectName}
                  </span>
                )}
              </div>
              {session.preview && (
                <p className="mt-0.5 truncate text-xs text-black/45 dark:text-white/45">{session.preview}</p>
              )}
              <p className="mt-0.5 text-[11px] text-black/35 dark:text-white/35">
                {session.runCount} {session.runCount === 1 ? 'turn' : 'turns'}
                {session.lastActivityAt ? ` · ${formatRelativeTime(session.lastActivityAt)}` : ''}
                {session.isRunning ? ' · running now' : ''}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
