'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

/**
 * The invite link, and the sentence that has to sit next to it.
 *
 * NO MAIL IS SENT, SO THE UI SAYS SO. `payload.config.ts` configures no email
 * adapter — Payload logs "No email adapter provided. Email will be written to
 * console." on every boot, confirmed live — and there is no nodemailer, resend
 * or sendgrid client anywhere in this project (`lib/notifications/digest.ts`
 * documents the same search). An "Invite sent" toast would therefore be a lie
 * that costs the invitee a day of waiting for mail that was never going to
 * arrive. The person who invited them is the transport, and this component
 * exists to make that unmistakable rather than discoverable.
 *
 * THE ORIGIN IS THE BROWSER'S. The server returns a PATH, not a URL: there is
 * no APP_URL in this project (`lib/auth.ts` falls back to localhost), so any
 * origin the server guessed would be wrong for anyone reaching this app over
 * Tailscale or a LAN address. `window.location.origin` is by construction an
 * origin that at least one real person can reach, because they are looking at
 * it.
 */
export function inviteUrl(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/invite/${token}`
}

export function CopyLinkButton({
  token,
  disabled,
  label = 'Copy link',
}: {
  token: string
  disabled?: boolean
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const url = inviteUrl(token)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      // Long enough to be read, short enough that the button is ready again
      // before somebody wants to copy a second link.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // `navigator.clipboard` is unavailable on an insecure origin, which is
      // exactly where this app runs over a LAN address. Showing the URL in a
      // toast is a worse copy affordance than the clipboard and a far better
      // one than a button that silently does nothing.
      toast({
        title: 'Copy this link by hand',
        description: url,
      })
    }
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={disabled}
      // The URL is NOT put in the title. `inviteUrl` reads
      // `window.location.origin`, which is empty during the server render, so a
      // title built from it differs between the two passes and React reports a
      // hydration mismatch on every invitation row. The click handler reads it
      // instead, where the origin genuinely exists.
      title={
        disabled
          ? 'This invitation has expired — invite the same address again to reissue the link.'
          : 'Copy the invitation link to the clipboard'
      }
      onClick={() => void copy()}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

/** The standing caveat, stated once so every surface that creates an invite
 * says the same thing. */
export function InviteDeliveryNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? 'mt-1 text-xs text-black/50 dark:text-white/50'}>
      This app sends no email. Creating an invitation produces a link — copy it and send it to them yourself. The
      link works once, only for the address you invite, and expires in seven days.
    </p>
  )
}
