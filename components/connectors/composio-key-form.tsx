'use client'

import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import type { KeyPresence } from '@/lib/connectors/composio'
import {
  clearComposioKey,
  setComposioKey,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/connectors/actions'

/**
 * The workspace's Composio key: whether one exists, where it comes from, and a
 * field to replace it.
 *
 * THERE IS NO WAY TO SEE THE KEY, AND THAT IS THE POINT. `collections/Workspaces.ts`
 * marks the field `read: () => false` so that no ordinary code path can
 * serialise it to a browser; an action that returned it — even behind a
 * "reveal" button, even for an owner — would defeat that from the inside, and
 * the one thing worse than an unusable secret is one everybody believes is
 * protected. What this shows instead is presence, source and LENGTH, which is
 * exactly enough to tell a truncated paste from a good key and useless to
 * anybody looking over a shoulder.
 *
 * THE SOURCE IS NAMED BECAUSE THE TWO ARE NOT INTERCHANGEABLE. Composio meters
 * and rate-limits per ORGANISATION: a workspace on its own key spends its own
 * budget, and a workspace falling back to the server's shares one bucket with
 * every other workspace on this deployment. "Set" would hide the difference,
 * and the difference is who pays and whose agent loop can rate-limit whom.
 */
export function ComposioKeyForm({
  workspaceSlug,
  initial,
}: {
  workspaceSlug: string
  initial: KeyPresence
}) {
  const [presence, setPresence] = useState(initial)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const next = unwrap(await setComposioKey({ workspaceSlug, apiKey: value }))
      setPresence(next)
      // Cleared immediately on success. A key left sitting in an input is one
      // a screen recording, a screenshot or a shoulder captures for as long as
      // the tab stays open.
      setValue('')
      toast({ title: 'Composio key saved' })
    } catch (error) {
      toast({
        title: 'Could not save the key',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    try {
      const next = unwrap(await clearComposioKey({ workspaceSlug }))
      setPresence(next)
      toast({
        title: 'Composio key removed',
        description: next.present
          ? 'This workspace now falls back to the server’s COMPOSIO_API_KEY.'
          : 'Connectors cannot be authorised until a key is set.',
      })
    } catch (error) {
      toast({
        title: 'Could not remove the key',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <KeyRound size={14} className="text-black/40 dark:text-white/40" />
        {presence.present ? (
          <>
            <Badge variant="secondary">set</Badge>
            <span className="text-xs text-black/50 dark:text-white/50">
              {presence.source === 'workspace'
                ? `This workspace’s own key, ${presence.length} characters.`
                : `Falling back to the server’s COMPOSIO_API_KEY, ${presence.length} characters. Every workspace on this server shares its rate limit.`}
            </span>
          </>
        ) : (
          <>
            <Badge variant="outline">not set</Badge>
            <span className="text-xs text-black/50 dark:text-white/50">
              No workspace key and no <code className="font-mono">COMPOSIO_API_KEY</code> on the server.
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={presence.source === 'workspace' ? 'Paste a new key to replace it' : 'Paste this workspace’s Composio API key'}
          className="max-w-sm font-mono text-xs"
        />
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy || value.trim().length === 0}>
          {busy ? 'Saving…' : presence.source === 'workspace' ? 'Replace' : 'Save'}
        </Button>
        {presence.source === 'workspace' && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void clear()} disabled={busy}>
            Remove
          </Button>
        )}
      </div>

      <p className="text-xs text-black/45 dark:text-white/45">
        Existing connections are never deleted when a key is removed — the record of who authorised what is what an
        incident is read from, and the grants themselves still exist at Composio.
      </p>
    </div>
  )
}
