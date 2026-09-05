'use client'

import { useEffect, useState, useTransition } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SkeletonList } from '@/components/ui/skeletons'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import {
  addConnector,
  browseToolkits,
  type ConnectorRowView,
  type ConnectorScopeType,
  type ToolkitOption,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/connectors/actions'

/**
 * Browse Composio's catalogue and attach one app at this scope.
 *
 * IT SEARCHES ON THE SERVER, NOT IN THE BROWSER. Composio publishes several
 * hundred toolkits and their own endpoint takes a `search` parameter;
 * downloading the whole list to filter it locally would spend a request
 * against a rate limit shared by the entire Composio organisation to do work
 * their index already did.
 *
 * ALREADY-ADDED APPS ARE SHOWN, GREYED, RATHER THAN HIDDEN. Somebody searching
 * for Gmail because they cannot find it needs to be told it is already here.
 * Hiding it answers their search with silence, which reads as "not available"
 * — the opposite of the truth.
 *
 * THE LIST IS NOT PAINTED OPTIMISTICALLY AND THE ADD IS NOT EITHER. Adding a
 * connector creates or finds an auth config at Composio, and that round trip
 * is the step that proves the workspace's key actually works — deferring it
 * would let an admin add six apps with a bad key and discover it only when a
 * colleague pressed Connect, putting the error in front of the one person who
 * cannot fix it. A row that appeared instantly and then vanished would be a
 * worse lie than a row that takes a moment.
 */

/** Long enough that typing "github" is one request rather than six, short
 * enough that it does not feel like waiting. */
const SEARCH_DEBOUNCE_MS = 300

export function ToolkitPicker({
  workspaceSlug,
  scopeType,
  scopeId,
  onClose,
  onAdded,
}: {
  workspaceSlug: string
  scopeType: ConnectorScopeType
  scopeId: number | null
  onClose: () => void
  onAdded: (row: ConnectorRowView) => void
}) {
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<ToolkitOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      // Null, not an empty array: the skeleton stands for "we are looking" and
      // an empty array means "there is nothing", and a screen that shows the
      // second while doing the first tells people to stop searching.
      setOptions(null)
      setError(null)
      try {
        const result = unwrap(await browseToolkits({ workspaceSlug, scopeType, scopeId, search: search || undefined }))
        if (!cancelled) setOptions(result)
      } catch (err) {
        if (!cancelled) {
          setOptions([])
          // Rendered in place rather than as a toast: the failure IS the
          // content of this dialog, and a toast over an empty list leaves
          // somebody looking at a blank box wondering what happened.
          setError(err instanceof Error ? err.message : 'Could not reach Composio.')
        }
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, workspaceSlug, scopeType, scopeId])

  async function add(option: ToolkitOption) {
    setAdding(option.slug)
    try {
      const row = unwrap(
        await addConnector({ workspaceSlug, scopeType, scopeId, toolkitSlug: option.slug, name: option.name }),
      )
      // The server's row has no logo or description (see `toRowView`'s own
      // comment) — this search result is the very place that data came from,
      // so merging it in here is free and saves a Composio round trip the
      // panel would otherwise need just to redraw the card it already has.
      startTransition(() => onAdded({ ...row, logo: option.logo, description: option.description }))
      setOptions((current) =>
        (current ?? []).map((item) => (item.slug === option.slug ? { ...item, alreadyAdded: true } : item)),
      )
    } catch (err) {
      toast({
        title: `Could not add ${option.name}`,
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setAdding(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an app</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-black/35 dark:text-white/35" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Composio's catalogue…"
            className="pl-8"
          />
        </div>

        <div className="max-h-80 overflow-y-auto">
          {options === null ? (
            <SkeletonList rows={6} />
          ) : error ? (
            <p className="px-1 py-6 text-center text-sm text-destructive">{error}</p>
          ) : options.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-black/50 dark:text-white/50">
              {search ? `Composio has no toolkit matching “${search}”.` : 'Composio returned no toolkits.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {options.map((option) => (
                <li
                  key={option.slug}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{option.name}</span>
                      <span className="font-mono text-[10px] text-black/35 dark:text-white/35">{option.slug}</span>
                    </div>
                    {option.description && (
                      <p className="truncate text-xs text-black/50 dark:text-white/50">{option.description}</p>
                    )}
                    {option.noAuth && (
                      // Worth saying, because the row will never grow a
                      // Connect button and its absence would otherwise read as
                      // a bug.
                      <p className="text-[11px] text-black/40 dark:text-white/40">
                        Needs no authorisation — nobody has to connect an account.
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant={option.alreadyAdded ? 'ghost' : 'outline'}
                    disabled={option.alreadyAdded || adding !== null}
                    onClick={() => void add(option)}
                  >
                    {option.alreadyAdded ? 'Added' : adding === option.slug ? 'Adding…' : 'Add'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
