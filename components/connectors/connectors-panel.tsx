'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Blocks, Mail, Plug, Plus, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useOptimisticAction } from '@/lib/optimistic'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { ToolkitPicker } from './toolkit-picker'
import {
  connectToolkit,
  removeConnector,
  setConnectorEnabled,
  revokeConnection,
  type ConnectorPanelData,
  type ConnectorRowView,
  type ConnectorScopeType,
} from '@/app/(app)/workspace/[workspaceSlug]/settings/connectors/actions'

/**
 * The Connectors surface, rendered identically in three places.
 *
 * ONE COMPONENT FOR SETTINGS, THE PROJECT TAB AND THE AGENT TAB. The three
 * differ by a `(scopeType, scopeId)` pair and a heading, and nothing else: the
 * list, the add flow, the connect flow and the permission-driven controls are
 * the same question asked about a different object. Three components would be
 * three places for "may I remove this" to drift, and the drift would be
 * invisible until somebody removed something they should not have.
 *
 * WHAT "CONNECTED" MEANS ON THIS SCREEN IS ALWAYS *YOURS*. Every status badge
 * and every Connect button refers to the VIEWER's own account, never the
 * agent's and never the last accountable user's. "You have not connected
 * Gmail" is a sentence somebody can act on; "this agent has not connected
 * Gmail" describes something that cannot be true, because an agent never
 * connects anything — it borrows a person's grant.
 *
 * EVERY MUTATION PAINTS FIRST. Enabling, disabling and removing all apply
 * locally and roll back with the server's own sentence on refusal
 * (`lib/optimistic.ts`). Adding does not: a new row's id comes from the server
 * and the auth-config round trip is the step that proves the workspace's key
 * works, so a row that appeared instantly and then vanished would be worse
 * than a row that took a moment to arrive.
 */

/** How often to re-ask while at least one authorisation is open. Two seconds
 * is short enough that returning from a consent screen feels immediate and
 * long enough that a person who leaves the tab open for a minute costs thirty
 * small requests rather than three hundred. */
const POLL_INTERVAL_MS = 2_000
/** A person who opens a consent screen and never comes back must not leave a
 * tab polling for the rest of the day. Five minutes is longer than any real
 * OAuth flow and is the point at which "still pending" stops being news. */
const POLL_CEILING_MS = 5 * 60 * 1000

/**
 * "Native" is a UI grouping only, not a fact `lib/connectors/composio.ts`
 * knows about — every toolkit here, allowlisted or not, is provisioned
 * through the same Composio auth-config flow (`findOrCreateAuthConfig`).
 * There is no second, hand-rolled OAuth path in this app to distinguish it
 * from. The badge exists because a person recognises "Slack" by name and does
 * not care whether Composio or something else sits behind it; this list is
 * that recognisability boundary, cosmetic and hardcoded on purpose rather
 * than a schema field for something no mutation ever needs to query. Extend
 * it by adding a slug — it needs no server change and no migration.
 */
const PRIMARY_TOOLKIT_SLUGS = new Set([
  'gmail',
  'googlecalendar',
  'google_calendar',
  'slack',
  'github',
  'googledrive',
  'google_drive',
  'telegram',
])

/** What `/api/connectors/status` returns per row. Deliberately narrower than
 * the `connections` document: no `redirectUrl` and no connected-account id,
 * because neither is of use to a screen and neither belongs in a response
 * fetched on an interval. */
interface PollDoc {
  id: number
  toolkitSlug: string
  status: 'pending' | 'active' | 'failed' | 'revoked'
  statusDetail: string | null
}

export function ConnectorsPanel({
  workspaceSlug,
  data,
  /** Shown above the list. The scope is not inferable from the rows — an empty
   * project tab and an empty agent tab look identical without it. */
  heading,
  description,
}: {
  workspaceSlug: string
  data: ConnectorPanelData
  heading?: string
  description?: string
}) {
  const [rows, setRows] = useState<ConnectorRowView[]>(data.connectors)
  const [picking, setPicking] = useState(false)
  const optimistic = useOptimisticAction()

  // The server is the source of truth for this list; a re-render after
  // `revalidatePath` must not be thrown away by stale local state.
  useEffect(() => {
    setRows(data.connectors)
  }, [data.connectors])

  const hasPending = useMemo(() => rows.some((row) => row.connection?.status === 'pending'), [rows])

  usePendingConnectionPoll({
    workspaceSlug,
    active: hasPending,
    onDocs: useCallback((docs: PollDoc[]) => {
      const byId = new Map(docs.map((doc) => [doc.id, doc]))
      setRows((current) =>
        current.map((row) => {
          if (!row.connection) return row
          const fresh = byId.get(row.connection.id)
          if (!fresh || fresh.status === row.connection.status) return row
          return {
            ...row,
            connection: { ...row.connection, status: fresh.status, statusDetail: fresh.statusDetail },
            blockedReason:
              fresh.status === 'active'
                ? null
                : fresh.status === 'pending'
                  ? 'connection_pending'
                  : 'connection_failed',
          }
        }),
      )
    }, []),
  })

  async function onConnect(row: ConnectorRowView) {
    try {
      const started = unwrap(await connectToolkit({ workspaceSlug, toolkitSlug: row.toolkitSlug }))
      // A NEW TAB, not this one. The person is mid-task on this screen and the
      // consent flow ends on a third-party domain; navigating away would lose
      // whatever else they were doing here, and the poll above is what brings
      // the answer back into this tab.
      window.open(started.redirectUrl, '_blank', 'noopener,noreferrer')
      setRows((current) =>
        current.map((item) =>
          item.id === row.id
            ? {
                ...item,
                connection: {
                  id: started.connectionId,
                  status: started.status,
                  redirectUrl: started.redirectUrl,
                  statusDetail: null,
                },
                blockedReason: 'connection_pending',
              }
            : item,
        ),
      )
    } catch (error) {
      toast({
        title: `Could not start the ${row.name} authorisation`,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  async function onDisconnect(row: ConnectorRowView) {
    const connection = row.connection
    if (!connection) return
    const previous = rows
    await optimistic.run({
      apply: () =>
        setRows((current) =>
          current.map((item) =>
            item.id === row.id
              ? { ...item, connection: { ...connection, status: 'revoked' }, blockedReason: 'connection_failed' }
              : item,
          ),
        ),
      rollback: () => setRows(previous),
      work: () => revokeConnection({ workspaceSlug, connectionId: connection.id }),
      failureTitle: `Could not disconnect ${row.name}`,
    })
  }

  async function onToggle(row: ConnectorRowView, enabled: boolean) {
    const previous = rows
    await optimistic.run({
      apply: () => setRows((current) => current.map((item) => (item.id === row.id ? { ...item, enabled } : item))),
      rollback: () => setRows(previous),
      work: () => setConnectorEnabled({ workspaceSlug, connectorId: row.id, enabled }),
      failureTitle: `Could not ${enabled ? 'enable' : 'disable'} ${row.name}`,
    })
  }

  async function onRemove(row: ConnectorRowView) {
    const previous = rows
    await optimistic.run({
      apply: () => setRows((current) => current.filter((item) => item.id !== row.id)),
      rollback: () => setRows(previous),
      work: () => removeConnector({ workspaceSlug, connectorId: row.id }),
      failureTitle: `Could not remove ${row.name}`,
    })
  }

  // Two tiers, not one flat list: `PRIMARY_TOOLKIT_SLUGS` above is the only
  // thing that decides which grid a row lands in, so a workspace that has
  // only long-tail toolkits attached sees one grid under "All other
  // integrations" rather than an empty primary section above it.
  const primaryRows = rows.filter((row) => PRIMARY_TOOLKIT_SLUGS.has(row.toolkitSlug.toLowerCase()))
  const otherRows = rows.filter((row) => !PRIMARY_TOOLKIT_SLUGS.has(row.toolkitSlug.toLowerCase()))

  const cardProps = {
    canAdminister: data.canAdminister,
    keyPresent: data.key.present,
    busy: optimistic.pending,
  }

  return (
    <div className="flex flex-col gap-4">
      {(heading || data.canAdminister) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {heading && <h2 className="text-sm font-medium">{heading}</h2>}
            {description && <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{description}</p>}
          </div>
          {data.canAdminister && (
            <Button type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
              <Plus /> Add an app
            </Button>
          )}
        </div>
      )}

      {!data.key.present && (
        // Said once, at the top, rather than as a badge on every row. Without a
        // key nothing here can work, and the sentence names the two places one
        // can come from because "not configured" would leave an admin guessing
        // which of them to go and set.
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <ShieldAlert size={14} className="mt-px shrink-0" />
          <span>
            No Composio API key is set for this workspace, and the server has no{' '}
            <code className="font-mono">COMPOSIO_API_KEY</code> either. Connectors listed here cannot be authorised
            until one of the two exists.
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title="No apps here yet"
          description={
            data.canAdminister
              ? 'Add an app to let agents at this scope act on your behalf in it.'
              : 'A workspace admin has not made any apps available at this scope.'
          }
          {...(data.canAdminister ? { action: { label: 'Add an app', onClick: () => setPicking(true) } } : {})}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {primaryRows.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {primaryRows.map((row) => (
                <ConnectorCard
                  key={row.id}
                  row={row}
                  {...cardProps}
                  onConnect={() => void onConnect(row)}
                  onDisconnect={() => void onDisconnect(row)}
                  onToggle={(enabled) => void onToggle(row, enabled)}
                  onRemove={() => void onRemove(row)}
                />
              ))}
            </ul>
          )}

          {(otherRows.length > 0 || data.canAdminister) && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-black/70 dark:text-white/70">All other integrations</h3>
                {data.canAdminister && <AddMoreMenu workspaceSlug={workspaceSlug} />}
              </div>
              {otherRows.length > 0 && (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {otherRows.map((row) => (
                    <ConnectorCard
                      key={row.id}
                      row={row}
                      {...cardProps}
                      onConnect={() => void onConnect(row)}
                      onDisconnect={() => void onDisconnect(row)}
                      onToggle={(enabled) => void onToggle(row, enabled)}
                      onRemove={() => void onRemove(row)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {picking && (
        <ToolkitPicker
          workspaceSlug={workspaceSlug}
          scopeType={data.scopeType as ConnectorScopeType}
          scopeId={data.scopeId == null ? null : Number(data.scopeId)}
          onClose={() => setPicking(false)}
          onAdded={(added) => setRows((current) => [...current, added])}
        />
      )}
    </div>
  )
}

/**
 * One app, as a card. Same row data and the same four handlers `ConnectorRow`
 * used to render as a compact list item — only the layout changed, into the
 * icon/badge/name/description/button shape the reference design asked for.
 * Nothing here decides differently than before: `status`, `keyPresent` and
 * `canAdminister` still gate exactly what they gated.
 */
function ConnectorCard({
  row,
  canAdminister,
  keyPresent,
  busy,
  onConnect,
  onDisconnect,
  onToggle,
  onRemove,
}: {
  row: ConnectorRowView
  canAdminister: boolean
  keyPresent: boolean
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const status = row.connection?.status ?? null
  const isPrimary = PRIMARY_TOOLKIT_SLUGS.has(row.toolkitSlug.toLowerCase())

  return (
    <li className="flex flex-col gap-2.5 rounded-xl border border-black/10 p-3.5 dark:border-white/10">
      <div className="flex items-start justify-between gap-2">
        <ToolkitIcon logo={row.logo} name={row.name} />
        <Badge
          variant="outline"
          className="shrink-0 text-[10px] font-medium tracking-wide text-black/40 uppercase dark:text-white/40"
        >
          {isPrimary ? 'Native' : 'MCP'}
        </Badge>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{row.name}</span>
          {!row.enabled && <Badge variant="outline">disabled</Badge>}
          {row.scopeType !== 'workspace' && <Badge variant="secondary">{row.scopeType}</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-black/50 dark:text-white/50">
          {row.description || row.toolkitSlug}
        </p>
        <p className="mt-1 text-[11px] text-black/40 dark:text-white/40">
          <ConnectionSentence status={status} detail={row.connection?.statusDetail ?? null} />
        </p>
      </div>

      <div className="mt-auto flex flex-col gap-1.5 pt-1">
        {status === 'active' ? (
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="w-full"
            onClick={onConnect}
            // A Connect button with no key behind it opens nothing and reports
            // a failure the person cannot fix. Disabled, with the reason
            // already stated once at the top of the panel.
            disabled={!keyPresent || status === 'pending'}
          >
            {status === 'pending' ? 'Waiting…' : status === null ? 'Connect' : 'Reconnect'}
          </Button>
        )}

        {canAdminister && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="flex-1"
              onClick={() => onToggle(!row.enabled)}
              disabled={busy}
            >
              {row.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={onRemove}
              disabled={busy}
              aria-label={`Remove ${row.name}`}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

/** The square logo tile. Composio's own artwork is an arbitrary remote URL —
 * not one of this app's own domains — so it is a plain `img`, not
 * `next/image`, which would need that host added to `next.config`'s allowed
 * remote patterns for every toolkit Composio ever adds. Falls back to an
 * initial on a tinted tile, both for toolkits `enrichWithToolkitMeta` never
 * found a logo for and for a URL that 404s after the fact. */
function ToolkitIcon({ logo, name }: { logo: string | null; name: string }) {
  const [broken, setBroken] = useState(false)
  if (!logo || broken) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-black/5 text-xs font-semibold text-black/50 uppercase dark:bg-white/10 dark:text-white/50">
        {name.charAt(0)}
      </span>
    )
  }
  return (
    // Composio's own CDN, an arbitrary third-party host per toolkit — never
    // one `next.config`'s remote patterns could enumerate in advance.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logo}
      alt=""
      className="size-8 shrink-0 rounded-md border border-black/5 object-contain dark:border-white/10"
      onError={() => setBroken(true)}
    />
  )
}

/**
 * The long tail's own add menu, distinct from the "Add an app" button above
 * the primary grid. That button already does the one thing this screen's
 * mutations support — searching Composio's catalogue via `ToolkitPicker` —
 * and stays exactly as it was. These three items are the reference design's
 * catch-all for everything Composio's catalogue does not cover, and each is
 * wired to whatever this app genuinely has today rather than a flow invented
 * to fill the slot:
 *
 * - "Add custom MCP server" opens the existing MCP catalog page. That page is
 *   itself read-only browse of this machine's bundled Hermes presets
 *   (`app/(app)/workspace/[workspaceSlug]/settings/mcp-catalog/page.tsx`'s own
 *   header says so) — there is no flow anywhere in this app to register an
 *   arbitrary MCP server URL, so this is the closest real destination, not a
 *   working "paste a URL" form.
 * - "Request an integration" has nothing to file a request against — no
 *   tracker, no admin contact stored anywhere this screen can reach — so it
 *   says that plainly instead of pretending to submit something.
 * - "Create a skill" is disabled outright: this codebase has no Skills
 *   collection and no skill-authoring surface (checked `collections/` and
 *   `docs/`), so a working link here would be a lie about what shipped.
 */
function AddMoreMenu({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus /> Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/workspace/${workspaceSlug}/settings/mcp-catalog`}>
            <Blocks /> Add custom MCP server
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            toast({
              title: 'Not yet available',
              description: 'There is no request-tracking flow here yet — tell your workspace admin which app you need.',
            })
          }
        >
          <Mail /> Request an integration
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Sparkles /> Create a skill
          <Badge variant="outline" className="ml-auto text-[9px]">
            Soon
          </Badge>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The one sentence per row that says where the viewer stands. Written out
 * rather than shown as a coloured dot, because "pending" and "failed" lead to
 * different actions and a colour cannot say which. */
function ConnectionSentence({ status, detail }: { status: string | null; detail: string | null }) {
  if (status === 'active') return <>You have connected this app.</>
  if (status === 'pending') return <>Waiting for you to finish authorising in the other tab.</>
  if (status === 'revoked') return <>You disconnected this app. Reconnect to use it again.</>
  if (status === 'failed') return <>{detail || 'The last authorisation attempt did not complete.'}</>
  return <>You have not connected this app yet.</>
}

/**
 * Poll `/api/connectors/status` while — and only while — something is pending.
 *
 * WHY POLLING IS THE RIGHT ANSWER HERE, WHEN D0 REJECTS IT IN GENERAL. D0's
 * rule is against spending requests to learn what a push already carries. This
 * state does not change here: it changes at the third party, in ANOTHER TAB,
 * and the only thing that could push it is a Composio connection-completed
 * webhook that `docs/HANDOFF-ENTERPRISE.md` explicitly records as unverified.
 * Building the primary path on a webhook nobody has seen fire is how a person
 * ends up watching a spinner that will never resolve.
 *
 * The bound is what makes it defensible rather than merely necessary: it runs
 * only between a click on Connect and a return from the consent screen, stops
 * on the first response with nothing pending, and stops again at a ceiling so
 * an abandoned tab does not poll all afternoon. An idle Connectors screen makes
 * no requests at all. The only alternative — a "check again" button — is the
 * same poll with the person as the timer.
 */
function usePendingConnectionPoll({
  workspaceSlug,
  active,
  onDocs,
}: {
  workspaceSlug: string
  active: boolean
  onDocs: (docs: PollDoc[]) => void
}) {
  const onDocsRef = useRef(onDocs)
  onDocsRef.current = onDocs

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const startedAt = Date.now()

    const tick = async () => {
      if (cancelled) return
      try {
        const response = await fetch(`/api/connectors/status?workspace=${encodeURIComponent(workspaceSlug)}`, {
          cache: 'no-store',
        })
        if (!response.ok) {
          // A 4xx here means the row or the access is gone, and no amount of
          // waiting changes that. Stopping is the honest response; the screen
          // keeps whatever it last knew.
          if (response.status < 500) cancelled = true
          return
        }
        const body = (await response.json()) as { docs: PollDoc[]; pending: boolean }
        if (cancelled) return
        onDocsRef.current(body.docs)
        // The server computes the stop condition, so the two cannot disagree
        // about what "still waiting" means.
        if (!body.pending) cancelled = true
      } catch {
        // A dropped request is not news — the next tick tries again, and the
        // ceiling below stops this eventually either way.
      }
    }

    void tick()
    const timer = window.setInterval(() => {
      if (cancelled || Date.now() - startedAt > POLL_CEILING_MS) {
        window.clearInterval(timer)
        return
      }
      void tick()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, workspaceSlug])
}
