'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { failureOf } from '@/lib/failures'
import { acceptInvitationAction } from '@/app/invite/[token]/actions'

/**
 * The one button that turns a link into a seat.
 *
 * DELIBERATELY NOT OPTIMISTIC, unlike the rest of this unit. Optimism paints a
 * state the client already knows; here the client knows nothing worth painting
 * — the outcome is a workspace it has never seen, at a slug the server has to
 * supply, behind a membership row that has to exist before the navigation can
 * succeed. Painting "you're in!" and then navigating to a 404 would be worse
 * than a second of a disabled button.
 *
 * THE FAILURE IS SHOWN IN PLACE, not as a toast. Every refusal
 * `acceptInvitation` can produce — revoked, expired, wrong address — is a
 * sentence the person has to act on, and a toast is a thing that disappears
 * while they are reading it. This is also the one screen in the app where the
 * person may have no other page to go back to.
 *
 * `router.refresh()` after the push, because the workspace layout renders the
 * sidebar from a membership list this action has just changed — without it the
 * new workspace is missing from the switcher on the first paint.
 */
export function AcceptInvitation({ token, workspaceName }: { token: string; workspaceName: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    setBusy(true)
    setError(null)
    const result = await acceptInvitationAction(token)
    const failure = failureOf(result)
    if (failure) {
      setError(failure.message)
      setBusy(false)
      return
    }
    const accepted = result as { workspaceSlug: string; channelId: number | null }
    // Straight to the channel when the invitation named one: being dropped at
    // the workspace root after being invited to a specific room is the moment
    // an invite stops feeling like it worked.
    router.push(
      accepted.channelId != null
        ? `/workspace/${accepted.workspaceSlug}/teams/${accepted.channelId}`
        : `/workspace/${accepted.workspaceSlug}`,
    )
    router.refresh()
    // `busy` is deliberately left true: the navigation is in flight and
    // re-enabling the button would invite a second accept against a token that
    // has already been consumed.
  }

  return (
    <div className="mt-4">
      <Button type="button" size="lg" disabled={busy} onClick={() => void accept()}>
        {busy ? 'Joining…' : `Join ${workspaceName}`}
      </Button>
      {error && (
        <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
