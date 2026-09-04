'use server'

import { getCurrentPayloadUser } from '@/lib/current-user'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { acceptInvitation, type AcceptedInvitation } from '@/lib/invitations'

/**
 * Accepting, as an action rather than as a link.
 *
 * A GET that grants workspace access would be triggered by anything that
 * follows links on a page: a link preview in a chat client, an email scanner, a
 * browser prefetch. The invitee would then find the invitation already used by
 * a machine that visited it on their behalf, and the honest error for a second
 * click ("this has already been used") would be indistinguishable from the bug.
 * So the link RENDERS a page and a deliberate press accepts.
 *
 * Every check `previewInvitation` made for the screen is made again inside
 * `acceptInvitation`, because this is a public endpoint reachable without the
 * screen ever having rendered.
 */
export async function acceptInvitationAction(
  token: string,
): Promise<WithFailure<AcceptedInvitation>> {
  return guard(async () => {
    const user = await getCurrentPayloadUser()
    if (!user) {
      raise('unauthenticated', 'Sign in with the invited email address, then open this link again.')
    }
    return acceptInvitation({ token, user: { id: user.id, email: user.email, name: user.name } })
  })
}
