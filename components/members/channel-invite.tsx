'use client'

import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useOptimisticAction } from '@/lib/optimistic'
import { inviteMemberAction } from '@/app/(app)/workspace/[workspaceSlug]/settings/members/actions'
import type { InvitableRole, InvitationRow } from '@/lib/invitations'
import { CopyLinkButton } from './invite-link'

/**
 * "Add somebody who is not in the workspace yet", from inside a channel.
 *
 * THE TWO CASES ARE DIFFERENT OPERATIONS AND THIS IS THE SECOND ONE. Adding a
 * person who is already in the workspace is a `team_members` row: no token, no
 * email, immediate. Adding a person who is not cannot be that, because there is
 * no user id to put in the row — they may not have an account at all. So this
 * creates a workspace invitation carrying `channelId`, and the accept path adds
 * them to the workspace AND to this channel in one step, which is what the
 * person clicking "add" meant.
 *
 * Kept as its own component rather than folded into the roster's picker: the
 * picker offers a list of people who exist, and an email box inside a
 * `<Select>` would be a control that looks like a search and is not.
 */
const ROLES: InvitableRole[] = ['admin', 'member', 'viewer']

export function ChannelInviteByEmail({
  workspaceId,
  workspaceSlug,
  teamId,
  channelName,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  channelName: string
}) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitableRole>('member')
  const [created, setCreated] = useState<InvitationRow | null>(null)
  const { run, pending } = useOptimisticAction()

  async function invite() {
    const address = email.trim()
    if (!address) return
    // Nothing to paint ahead of the server: the whole output of this action is
    // a token only the server can mint.
    await run({
      apply: () => {},
      rollback: () => {},
      work: () =>
        inviteMemberAction({ workspaceId, workspaceSlug, email: address, role, channelId: teamId }),
      failureTitle: 'Could not create the invitation',
      onSettled: (value) => {
        setCreated((value as { invitation: InvitationRow }).invitation)
        setEmail('')
      },
    })
  }

  if (!open) {
    return (
      <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <Mail size={12} />
        Invite by email
      </Button>
    )
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-black/10 p-2 dark:border-white/10">
      <p className="text-[11px] text-black/45 dark:text-white/45">
        For somebody who is not in this workspace yet. They join the workspace and land in {channelName}.
      </p>
      <Input
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="their@email.example"
        aria-label="Email address to invite"
        className="h-7 text-xs"
        disabled={pending}
      />
      <Select value={role} onValueChange={(value) => setRole(value as InvitableRole)}>
        <SelectTrigger className="h-7 w-full text-xs" aria-label="Role in the workspace">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex gap-1.5">
        <Button type="button" size="xs" disabled={pending || !email.trim()} onClick={() => void invite()}>
          Create invite link
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            setCreated(null)
          }}
        >
          Cancel
        </Button>
      </div>
      {created && (
        <div className="space-y-1 border-t border-black/[.06] pt-1.5 dark:border-white/[.06]">
          <p className="text-[11px] text-black/45 dark:text-white/45">
            No email was sent — this app has no mail transport. Copy the link and send it to {created.email}
            yourself.
          </p>
          <CopyLinkButton token={created.token} label={`Copy link for ${created.email}`} />
        </div>
      )}
    </div>
  )
}
