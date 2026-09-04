'use client'

import { useMemo, useState } from 'react'
import { Mail, ShieldAlert, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { useOptimisticAction } from '@/lib/optimistic'
import { failureOf } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { formatTimestamp } from '@/lib/relative-time'
import { WORKSPACE_ROLES, type WorkspaceRole } from '@/lib/permissions/model'
import type { InvitationRow, MemberRow } from '@/lib/invitations'
import { CopyLinkButton, InviteDeliveryNotice, inviteUrl } from './invite-link'
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/members/actions'

/**
 * The member list, the roles, and the pending invitations.
 *
 * WHY THIS IS ONE CLIENT COMPONENT AND NOT FOUR. Every mutation on this screen
 * changes the SAME two lists — promoting somebody changes the owner count that
 * decides whether the last-owner controls are locked, accepting an invite would
 * move a row from one list to the other. Split across components, each of those
 * becomes a `router.refresh()` and a full server round trip to show a state the
 * browser already knew (D0). Held together, they are local state and the paint
 * is immediate.
 *
 * THE LAST-OWNER RULE IS SHOWN, NOT DISCOVERED. The server refuses to demote or
 * remove the only owner and that refusal is the one that counts — but a control
 * offered and then refused teaches the rule the expensive way, one support
 * message at a time. `owners` is recomputed locally from the same list the
 * dropdowns write to, so the lock appears the instant a second owner is made
 * and disappears the instant one is taken away.
 *
 * NOTHING HERE CLAIMS AN EMAIL WAS SENT. See `./invite-link.tsx` — that
 * component owns the sentence, and it is placed on every surface that produces
 * a link.
 */
export function MembersView({
  workspaceId,
  workspaceSlug,
  workspaceName,
  initialMembers,
  initialInvitations,
  viewerRole,
  viewerId,
}: {
  workspaceId: number
  workspaceSlug: string
  workspaceName: string
  initialMembers: MemberRow[]
  initialInvitations: InvitationRow[]
  viewerRole: WorkspaceRole
  viewerId: number
}) {
  const canShare = viewerRole === 'owner' || viewerRole === 'admin'

  // Mirrors of the server's lists. Seeded from props on every server render, so
  // `revalidatePath` in the actions is what reconciles them; between renders
  // these are what the screen is actually drawing.
  const [members, setMembers] = useState(initialMembers)
  const [invitations, setInvitations] = useState(initialInvitations)
  const { run, pending } = useOptimisticAction()

  const owners = useMemo(() => members.filter((member) => member.role === 'owner').length, [members])

  // Owner first, then admins, then by when they joined. The column being
  // scanned is the roles, so ordering by name would turn "who can administer
  // this workspace" into a reading exercise.
  const ordered = useMemo(() => {
    const rank: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }
    return [...members].sort((a, b) => rank[a.role] - rank[b.role] || a.joinedAt.localeCompare(b.joinedAt))
  }, [members])

  return (
    <>
      {canShare && (
        <InvitePanel
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          workspaceName={workspaceName}
          busy={pending}
          onCreated={(invitation) =>
            setInvitations((current) => [invitation, ...current.filter((row) => row.id !== invitation.id)])
          }
        />
      )}

      <section className="mb-8 max-w-3xl">
        <h2 className="mb-2 text-sm font-medium">
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </h2>
        <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
          {ordered.map((member) => {
            const isSelf = member.userId === viewerId
            const isLastOwner = member.role === 'owner' && owners <= 1
            // Only an owner may change or remove another owner: `owner` is the
            // one role that can delete and transfer the workspace, so an admin
            // able to unseat one would be an admin able to take it.
            const ownerLocked = member.role === 'owner' && viewerRole !== 'owner'
            const roleLocked = !canShare || isLastOwner || ownerLocked
            const removeLocked = !canShare || isLastOwner || ownerLocked || isSelf
            const lockReason = isLastOwner
              ? 'The only owner cannot be changed or removed. Make somebody else an owner first.'
              : ownerLocked
                ? 'Only an owner can change another owner.'
                : isSelf
                  ? 'You cannot remove yourself here. Ask another owner or admin.'
                  : 'Only an owner or an admin can change who is in a workspace.'

            return (
              <div
                key={member.memberId}
                className="flex flex-wrap items-center gap-3 border-b border-black/[.06] px-3 py-2.5 last:border-b-0 dark:border-white/[.06]"
              >
                <div className="min-w-0 flex-[2] basis-48">
                  <p className="flex items-center gap-1.5 truncate text-sm">
                    {member.name}
                    {isSelf && <span className="text-[10px] text-black/35 dark:text-white/35">you</span>}
                  </p>
                  <p className="truncate text-xs text-black/45 dark:text-white/45">
                    {member.email}
                    {member.invitedByName && <> · invited by {member.invitedByName}</>}
                  </p>
                </div>

                <p className="hidden w-36 shrink-0 text-xs text-black/40 lg:block dark:text-white/40">
                  joined {formatTimestamp(member.joinedAt)}
                </p>

                {roleLocked ? (
                  <span
                    className="w-28 shrink-0 rounded-md border border-black/10 px-2 py-1 text-center text-xs capitalize text-black/55 dark:border-white/10 dark:text-white/55"
                    title={lockReason}
                  >
                    {member.role}
                  </span>
                ) : (
                  <Select
                    value={member.role}
                    disabled={pending}
                    onValueChange={(next) => {
                      const role = next as WorkspaceRole
                      const previous = member.role
                      void run({
                        apply: () =>
                          setMembers((current) =>
                            current.map((row) => (row.userId === member.userId ? { ...row, role } : row)),
                          ),
                        rollback: () =>
                          setMembers((current) =>
                            current.map((row) =>
                              row.userId === member.userId ? { ...row, role: previous } : row,
                            ),
                          ),
                        work: () =>
                          changeMemberRoleAction({ workspaceId, workspaceSlug, userId: member.userId, role }),
                        failureTitle: `Could not change ${member.name}'s role`,
                      })
                    }}
                  >
                    <SelectTrigger className="h-7 w-28 shrink-0 text-xs" aria-label={`Role for ${member.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* An admin cannot mint an owner — the action refuses it
                          too, and offering the option would be a control whose
                          only outcome is a toast. */}
                      {WORKSPACE_ROLES.filter((value) => value !== 'owner' || viewerRole === 'owner').map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                )}

                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={pending || removeLocked}
                  aria-label={`Remove ${member.name}`}
                  title={removeLocked ? lockReason : `Remove ${member.name} from this workspace`}
                  onClick={() => {
                    const snapshot = members
                    void run({
                      apply: () =>
                        setMembers((current) => current.filter((row) => row.userId !== member.userId)),
                      rollback: () => setMembers(snapshot),
                      work: () => removeMemberAction({ workspaceId, workspaceSlug, userId: member.userId }),
                      failureTitle: `Could not remove ${member.name}`,
                    })
                  }}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-black/40 dark:text-white/40">
          An owner can do everything including deleting and transferring the workspace; an admin everything else; a
          member can work but not change access; a viewer can only read.
        </p>
      </section>

      {canShare && (
        <section className="max-w-3xl">
          <h2 className="mb-2 text-sm font-medium">Pending invitations</h2>
          {invitations.length === 0 ? (
            <EmptyState
              icon={<Mail />}
              title="Nobody is waiting"
              description="Every invitation has been accepted, revoked, or was never sent."
            />
          ) : (
            <ul className="space-y-2">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{invitation.email}</span>
                    <span className="shrink-0 rounded-full border border-black/10 px-2 py-0.5 text-[11px] capitalize text-black/55 dark:border-white/10 dark:text-white/55">
                      {invitation.role}
                    </span>
                    {invitation.expired ? (
                      <span
                        className="flex shrink-0 items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
                        title="The link no longer works. Invite the same address again to reissue it."
                      >
                        <ShieldAlert size={11} />
                        expired {formatTimestamp(invitation.expiresAt)}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11px] text-black/40 dark:text-white/40">
                        expires {formatTimestamp(invitation.expiresAt)}
                      </span>
                    )}
                    <CopyLinkButton token={invitation.token} disabled={invitation.expired} />
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      title="Withdraw this invitation — the link stops working immediately"
                      onClick={() => {
                        const snapshot = invitations
                        void run({
                          apply: () =>
                            setInvitations((current) => current.filter((row) => row.id !== invitation.id)),
                          rollback: () => setInvitations(snapshot),
                          work: () =>
                            revokeInvitationAction({ workspaceId, workspaceSlug, invitationId: invitation.id }),
                          failureTitle: `Could not revoke the invitation for ${invitation.email}`,
                        })
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                  {/* The URL is deliberately NOT rendered here. `inviteUrl`
                      reads `window.location.origin`, which is empty during the
                      server render, so putting it in the markup would be a
                      hydration mismatch on every row. The copy button reads it
                      at click time, where the origin exists. */}
                  <p className="mt-1 truncate text-[11px] text-black/35 dark:text-white/35">
                    {invitation.invitedByName ? `Invited by ${invitation.invitedByName}. ` : ''}
                    Nothing was emailed — send them this link yourself.
                    {invitation.channelId != null && ' Accepting also puts them in the channel they were invited to.'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}

/**
 * Create an invitation.
 *
 * Deliberately NOT optimistic, unlike everything else on this screen. The
 * outcome a person needs is the TOKEN, and the token only exists once the
 * server has written the row — there is nothing honest to paint in the
 * meantime. Optimism is for a state the client already knows; this is the one
 * mutation here where it does not.
 */
function InvitePanel({
  workspaceId,
  workspaceSlug,
  workspaceName,
  busy,
  onCreated,
}: {
  workspaceId: number
  workspaceSlug: string
  workspaceName: string
  busy: boolean
  onCreated: (invitation: InvitationRow) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member')
  const [sending, setSending] = useState(false)
  const [created, setCreated] = useState<InvitationRow | null>(null)

  async function submit() {
    if (!email.trim() || sending) return
    setSending(true)
    try {
      const result = await inviteMemberAction({ workspaceId, workspaceSlug, email: email.trim(), role })
      const failure = failureOf(result)
      if (failure) {
        toast({ title: 'Could not create the invitation', description: failure.message, variant: 'destructive' })
        return
      }
      const { invitation } = result as { invitation: InvitationRow }
      setEmail('')
      setCreated(invitation)
      onCreated(invitation)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="mb-6 max-w-3xl rounded-lg border border-black/10 p-4 dark:border-white/10">
      <h2 className="flex items-center gap-1.5 text-sm font-medium">
        <Mail size={14} />
        Invite somebody to {workspaceName}
      </h2>
      {/* The caveat goes BEFORE the button, not after the click: somebody who
          reads "invite" and expects mail to go out has to learn otherwise while
          they are still looking at the screen. */}
      <InviteDeliveryNotice className="mt-1 max-w-2xl text-xs text-black/50 dark:text-white/50" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          type="email"
          placeholder="colleague@example.com"
          aria-label="Email address to invite"
          className="h-8 w-72 max-w-full text-sm"
          disabled={sending || busy}
        />
        <Select value={role} onValueChange={(v) => setRole(v as typeof role)} disabled={sending || busy}>
          <SelectTrigger className="h-8 w-32 text-sm" aria-label="Role for the invited person">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* `owner` is absent by design: ownership is transferred, never
                invited — `collections/Invitations.ts` refuses it too. */}
            {(['admin', 'member', 'viewer'] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" disabled={sending || busy || !email.trim()} onClick={() => void submit()}>
          <UserPlus size={13} />
          {sending ? 'Creating…' : 'Create invite link'}
        </Button>
      </div>

      {created && (
        <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2">
          <p className="text-xs">
            Link ready for <span className="font-medium">{created.email}</span>. Copy it and send it to them —
            nothing was emailed.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-black/10 bg-white/60 px-2 py-1 text-[11px] dark:border-white/10 dark:bg-black/30">
              {inviteUrl(created.token)}
            </code>
            <CopyLinkButton token={created.token} label="Copy" />
          </div>
        </div>
      )}
    </section>
  )
}
