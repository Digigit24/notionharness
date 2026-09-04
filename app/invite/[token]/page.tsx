import Link from 'next/link'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { previewInvitation } from '@/lib/invitations'
import { AcceptInvitation } from '@/components/members/accept-invitation'

/**
 * The invitation landing page.
 *
 * WHY IT IS NOT UNDER `app/(app)/`. That group's layout is
 * `if (!session) redirect('/login')`, and an invitation is the one link in this
 * product whose entire purpose is to be opened by somebody who does not have an
 * account yet. Placed inside the group, every invitee would be bounced to the
 * login page with the token surviving only in their browser history — the exact
 * failure the `?next=` round trip below exists to prevent. So it sits beside
 * `app/(auth)/`, reachable signed in or out, and does its own membership work.
 *
 * FIVE REFUSALS, NOT ONE. `previewInvitation` returns a machine-readable
 * `reason` precisely so this screen can give each case its own sentence and its
 * own next action. "This invitation is invalid" is the version that generates a
 * support ticket every single time, because the recipient cannot tell whether
 * to ask for a new link, sign in as somebody else, stop trying, or simply open
 * the workspace they are already in.
 *
 * ACCEPTING IS A BUTTON, NOT THE PAGE LOAD. A GET that grants access is
 * triggered by anything that follows links: a chat client's preview fetcher, a
 * mail scanner, a browser prefetch. The invitee would then arrive at a link
 * already consumed by a machine acting on their behalf. `./actions.ts` carries
 * the same reasoning for the server half.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const user = await getCurrentPayloadUser()
  const invitation = await previewInvitation(
    token,
    user ? { id: user.id, email: user.email } : null,
  )

  if (!invitation) {
    return (
      <Shell title="This link is not one we recognise">
        <p>
          The invitation may have been deleted, or the link may have been altered in transit — a link that has been
          broken across two lines in a chat message is the usual cause. Ask whoever invited you to send a new one.
        </p>
      </Shell>
    )
  }

  const workspace = <span className="font-medium">{invitation.workspaceName}</span>
  const from = invitation.invitedByName ? <> by {invitation.invitedByName}</> : null

  // Signed out. Not a refusal — it is the normal first state of an invite link,
  // and saying anything about the invitation being wrong here would be a lie.
  // `next` carries the invitee back to this exact URL after they authenticate;
  // `components/auth/next-path.ts` is what stops that parameter being an open
  // redirect on the one page strangers are meant to be sent links to.
  if (!user) {
    const next = encodeURIComponent(`/invite/${token}`)
    return (
      <Shell title={`You have been invited to ${invitation.workspaceName}`}>
        <p>
          The invitation{from} is for <span className="font-medium">{invitation.email}</span>
          {invitation.channelName ? (
            <>
              , and it puts you in <span className="font-medium">#{invitation.channelName}</span>
            </>
          ) : null}
          . Sign in with that address — or create an account for it — and you will come straight back here.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href={`/signup?next=${next}`}
            className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
          >
            Create an account
          </Link>
          <Link
            href={`/login?next=${next}`}
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
          >
            I already have one
          </Link>
        </div>
      </Shell>
    )
  }

  switch (invitation.reason) {
    case 'revoked':
      return (
        <Shell title="This invitation was withdrawn">
          <p>
            Somebody with access to {workspace} revoked it after it was sent. Nothing you did caused this. Ask them
            to invite you again if it was a mistake.
          </p>
        </Shell>
      )

    case 'expired':
      return (
        <Shell title="This invitation has expired">
          <p>
            It stopped working on {new Date(invitation.expiresAt).toLocaleDateString()}. Invitations last seven
            days. Ask whoever invited you to {workspace} to send a fresh link — inviting the same address again
            reissues this one rather than creating a second.
          </p>
        </Shell>
      )

    case 'accepted':
      return (
        <Shell title="This invitation has already been used">
          <p>
            If that was you, {workspace} is already in your sidebar and nothing further is needed. If it was not,
            tell whoever sent it: a link that has been used by somebody else is worth knowing about.
          </p>
          <HomeLink />
        </Shell>
      )

    case 'wrong_email':
      return (
        <Shell title="This invitation is for a different address">
          <p>
            It was sent to <span className="font-medium">{invitation.email}</span>, and you are signed in as{' '}
            <span className="font-medium">{user.email}</span>. An invitation is bound to the address it was sent to,
            so a forwarded link cannot be accepted by whoever received it — sign in as the invited address, or ask
            for an invitation to this one.
          </p>
          <HomeLink />
        </Shell>
      )

    case 'already_member':
      return (
        <Shell title={`You are already in ${invitation.workspaceName}`}>
          <p>Nothing to accept. Open it from your sidebar.</p>
          <Link
            href={`/workspace/${invitation.workspaceSlug}`}
            className="mt-4 inline-block rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
          >
            Open {invitation.workspaceName}
          </Link>
        </Shell>
      )

    case null:
      return (
        <Shell title={`Join ${invitation.workspaceName}`}>
          <p>
            You were invited{from} as a <span className="font-medium">{invitation.role}</span>
            {invitation.channelName ? (
              <>
                , and accepting also puts you in <span className="font-medium">#{invitation.channelName}</span>
              </>
            ) : null}
            .
          </p>
          <AcceptInvitation token={invitation.token} workspaceName={invitation.workspaceName} />
        </Shell>
      )
  }
}

/** One frame for every outcome, so the five refusals and the acceptance read as
 * the same screen rather than as five different pages that happen to share a
 * URL. Matches `app/(auth)/login/page.tsx`'s centred, chrome-free shape: this
 * is reached before anybody has a workspace to put a sidebar around. */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-[#f7f7f5] px-6 py-16 dark:bg-[#191919]">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 dark:border-white/10 dark:bg-[#202020]">
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="mt-2 text-sm leading-relaxed text-black/60 dark:text-white/60">{children}</div>
      </div>
    </div>
  )
}

function HomeLink() {
  return (
    <Link href="/" className="mt-4 inline-block text-sm underline">
      Go to your workspaces
    </Link>
  )
}
