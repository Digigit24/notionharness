'use client'

/**
 * The Channels tab's channel list: every channel in the workspace, the agents
 * standing in it, and what the viewer has not read.
 *
 * `import type` and nothing else from `./channels-data` — that module imports
 * the broker, which imports `pg`. Types are erased at compile time, so the
 * driver never reaches the browser bundle. (Same rule, and same reason, as
 * components/teams/shared.ts.)
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Plus, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { registerChannelNames } from '@/lib/channel-name-cache'
import { ChannelCreateDialog } from '@/components/teams/channel-create-dialog'
import type { TeamAgentOption, TeamUserOption } from '@/components/teams/shared'
import type { SidebarChannel, SidebarChannels } from './channels-data'

/** Members rendered under one expanded channel before "+N more". */
const MEMBER_LIMIT = 6

export function ChannelList({
  workspaceSlug,
  workspaceId,
  data,
  activeChannelId,
  agents,
  users,
}: {
  workspaceSlug: string
  workspaceId: number
  /**
   * `undefined` means the layout is not passing channels yet, `null` means the
   * broker could not answer, and an empty `channels` array means this
   * workspace genuinely has none. Three different things, rendered three
   * different ways — collapsing them into one "No channels yet" empty state
   * would be a confident lie in two cases out of three.
   */
  data: SidebarChannels | null | undefined
  activeChannelId: number | null
  /** The "+" popup's rosters. Empty arrays rather than omitted — a workspace
   * with nobody to add yet still gets a working (if empty) picker rather than
   * losing the "+" button entirely. */
  agents: TeamAgentOption[]
  users: TeamUserOption[]
}) {
  const teamsHref = `/workspace/${workspaceSlug}/teams`

  // Feeds `[teamId]/loading.tsx`'s breadcrumb — see `lib/channel-name-cache.ts`
  // for why this is a cache write, not a fetch. `data?.channels` rather than
  // `data` alone: `undefined`/`null` mean "nothing to register", not "clear
  // what's there" (a workspace switch that briefly shows no data must not
  // blank out the previous workspace's cached names while it loads).
  useEffect(() => {
    if (data?.channels) registerChannelNames(data.channels)
  }, [data])

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between px-2">
        {/* The label itself is now the way to the full Teams list — "All" used
            to sit here as a separate link, but a "+" is far more useful in
            that exact spot: it's the ONE thing the sidebar's channel section
            couldn't do at all until now (open a channel-creation popup with
            member/agent pickers, reusing the same dialog the Teams page
            already built — see channel-create-dialog.tsx). */}
        <Link
          href={teamsHref}
          title="Browse all channels"
          className="text-xs font-medium text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        >
          Channels
        </Link>
        <ChannelCreateDialog
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          agents={agents}
          users={users}
          trigger={
            <button
              type="button"
              title="New channel"
              className="flex h-5 w-5 items-center justify-center rounded text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.08] dark:hover:text-white/70"
            >
              <Plus size={13} />
            </button>
          }
        />
      </div>

      {data === undefined || data === null ? (
        // No invented empty state here. The list is simply absent and the one
        // honest affordance — the full Teams page, which loads its own data —
        // is offered instead.
        <Link
          href={teamsHref}
          className="mx-0 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]"
        >
          <Users size={14} />
          Browse channels
        </Link>
      ) : data.channels.length === 0 ? (
        <p className="px-2 py-1 text-xs text-black/40 dark:text-white/40">
          No channels yet.{' '}
          <Link href={teamsHref} className="underline underline-offset-2 hover:text-black/70 dark:hover:text-white/70">
            Create one
          </Link>
          .
        </p>
      ) : (
        <>
          {data.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              workspaceSlug={workspaceSlug}
              isActive={channel.id === activeChannelId}
            />
          ))}
          {data.hiddenCount > 0 && (
            <Link
              href={teamsHref}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-black/40 hover:bg-black/[.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/[.08] dark:hover:text-white/70"
            >
              +{data.hiddenCount} more
            </Link>
          )}
        </>
      )}
    </div>
  )
}

function ChannelRow({
  channel,
  workspaceSlug,
  isActive,
}: {
  channel: SidebarChannel
  workspaceSlug: string
  isActive: boolean
}) {
  // The channel you are standing in shows its roster; the rest stay one line
  // each. Expanding all of them by default turns a list of twelve rooms into
  // seventy rows, which is the wall of links the tabs exist to remove.
  const [open, setOpen] = useState(isActive)
  const members = channel.members.slice(0, MEMBER_LIMIT)
  const overflow = channel.memberCount - members.length
  const hasUnread = channel.unreadCount > 0

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-0.5 rounded-md pr-1.5',
          isActive ? 'bg-black/[.06] dark:bg-white/[.08]' : 'hover:bg-black/[.04] dark:hover:bg-white/[.06]',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `Hide members of ${channel.name}` : `Show members of ${channel.name}`}
          className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-black/30 hover:text-black/70 dark:text-white/30 dark:hover:text-white/70"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Link
          href={`/workspace/${workspaceSlug}/teams/${channel.id}`}
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-sm"
          title={channel.name}
        >
          <span className="shrink-0 text-black/30 dark:text-white/30">#</span>
          <span
            className={cn(
              'truncate',
              hasUnread ? 'font-semibold text-black dark:text-white' : 'text-black/70 dark:text-white/70',
            )}
          >
            {channel.name}
          </span>
        </Link>
        {/* Mentions first and in their own colour: "someone asked YOU" outranks
            "the room is busy", and a single merged count would hide it. */}
        {channel.mentionCount > 0 && (
          <span
            title={`${channel.mentionCount} mention${channel.mentionCount === 1 ? '' : 's'}`}
            className="flex h-4 shrink-0 items-center rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white tabular-nums"
          >
            @{channel.mentionCount}
          </span>
        )}
        {hasUnread && (
          <span
            title={`${channel.unreadCount} unread`}
            className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-black/10 px-1 text-[10px] font-semibold text-black/70 tabular-nums dark:bg-white/15 dark:text-white/80"
          >
            {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
          </span>
        )}
      </div>

      {open && (
        <div className="mb-1 ml-[18px] border-l border-black/5 pl-1.5 dark:border-white/10">
          {channel.memberCount === 0 && (
            <p className="px-1.5 py-0.5 text-[11px] text-black/35 dark:text-white/35">No members yet</p>
          )}
          {members.map((member) => {
            const dot = (
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: member.colour ?? '#64748b' }}
              />
            )
            const body = (
              <>
                {dot}
                <span className="truncate">{member.displayName}</span>
                {member.isLeader && (
                  <span className="ml-auto shrink-0 text-[9px] text-black/30 uppercase dark:text-white/30">lead</span>
                )}
              </>
            )
            const className =
              'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-black/55 dark:text-white/55'
            // A slot backed by a person has no agent page to open (migration
            // 0013 made `agent_id` nullable), so it renders as text rather than
            // a link that would 404.
            return member.agentId == null ? (
              <div key={member.slotId} className={className} title={`${member.displayName} (you or another person)`}>
                {body}
              </div>
            ) : (
              <Link
                key={member.slotId}
                href={`/workspace/${workspaceSlug}/agents/${member.agentId}`}
                className={cn(className, 'hover:bg-black/[.04] hover:text-black/80 dark:hover:bg-white/[.06] dark:hover:text-white/80')}
                title={`Open ${member.displayName}'s agent`}
              >
                {body}
              </Link>
            )
          })}
          {overflow > 0 && (
            <Link
              href={`/workspace/${workspaceSlug}/teams/${channel.id}`}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-black/35 hover:text-black/70 dark:text-white/35 dark:hover:text-white/70"
            >
              +{overflow} more
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
