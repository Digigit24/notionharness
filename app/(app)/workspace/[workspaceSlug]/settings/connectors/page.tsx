import { notFound } from 'next/navigation'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { loadAccess, can } from '@/lib/permissions'
import { describeKey } from '@/lib/connectors/composio'
import { listConnectorAudit } from '@/lib/connectors/audit'
import { ConnectorsPanel } from '@/components/connectors/connectors-panel'
import { ComposioKeyForm } from '@/components/connectors/composio-key-form'
import { ConnectorActivity } from '@/components/connectors/connector-activity'
import { EmptyState } from '@/components/ui/empty-state'
import { ConnectionCoverage } from '@/components/connectors/connection-coverage'
import { getConnectionCoverage, getConnectorPanel } from './actions'
import { isFailureEnvelope } from '@/lib/failures'
import { Lock } from 'lucide-react'

export const metadata = {
  title: 'Connectors | NotionForge',
}

/**
 * Settings → Connectors: the workspace-wide view.
 *
 * FOUR READS, ISSUED TOGETHER. The panel, the key's presence, the coverage
 * summary and the recent trail are independent, and awaiting them one after
 * another against a remote database would serialise four round trips for a
 * screen that needs all four to paint (D0).
 *
 * WHAT IS ON THIS SCREEN AND NOT ON THE OTHER TWO: the key, the coverage
 * summary and the trail. Everything else — the connector list, the add flow,
 * each person's own connection state — is the same `ConnectorsPanel` the
 * project and agent tabs render, because it is the same question asked about a
 * different scope.
 *
 * THE COVERAGE SUMMARY IS BOUNDED ON PURPOSE. It says WHO has authorised WHICH
 * app and in what state, and stops there — no email of the Google account, no
 * Slack workspace, no connected-account id. That is the line
 * `docs/HANDOFF-ENTERPRISE.md` draws ("existence and status, never a token, and
 * never the third-party account's own details") and it is the right one: an
 * admin has a real interest in whether the connector they switched on is usable
 * by anybody, and none at all in whose mailbox it reaches.
 */
export default async function ConnectorsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const user = await getCurrentPayloadUser()
  if (!user) notFound()

  const access = await loadAccess(user.id, workspace.id)
  if (!can(access, 'read', 'workspace')) notFound()
  const isAdmin = can(access, 'administer', 'workspace')

  const [panelResult, key, audit, coverage] = await Promise.all([
    getConnectorPanel({ workspaceSlug, scopeType: 'workspace' }),
    // Read directly rather than through the panel's copy: the key section
    // renders even when the panel itself failed to load, because "your key is
    // wrong" is exactly the sentence a failed panel needs beside it.
    describeKey(workspace.id),
    isAdmin ? listConnectorAudit(workspace.id) : Promise.resolve([]),
    // Admin-only, and issued with the rest rather than after them: four
    // independent reads awaited one at a time would be four serial round trips
    // against a remote database for a screen that needs all four to paint (D0).
    isAdmin ? getConnectionCoverage({ workspaceSlug }) : Promise.resolve(null),
  ])

  return (
    <main className="w-full max-w-3xl px-5 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Connectors</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">
          Third-party apps this workspace has switched on, and the account each person has authorised in them. A
          connector says an app is available; a connection is your own credential, and agents can only ever act with
          the credential of the person accountable for the run.
        </p>
      </div>

      {isAdmin ? (
        <section className="mb-8 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-medium">Composio API key</h2>
          <p className="mb-3 mt-1 text-xs text-black/50 dark:text-white/50">
            Composio bills and rate-limits per organisation, so a workspace with its own key spends its own budget
            rather than sharing one bucket with everyone else on this server.
          </p>
          <ComposioKeyForm workspaceSlug={workspaceSlug} initial={key} />
        </section>
      ) : (
        // Members see that a key exists without seeing anything about it. The
        // alternative — hiding the section entirely — makes "why can I not
        // connect anything" unanswerable without asking an admin.
        <section className="mb-8 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Lock size={13} className="text-black/40 dark:text-white/40" />
            Composio API key
          </h2>
          <p className="mt-1 text-xs text-black/50 dark:text-white/50">
            {key.present
              ? 'A key is configured for this workspace. Only an admin can change it.'
              : 'No key is configured, so nothing here can be authorised yet. Ask an admin to set one.'}
          </p>
        </section>
      )}

      <section className="mb-8">
        {isFailureEnvelope(panelResult) ? (
          <EmptyState
            title="Could not load connectors"
            description={panelResult.__failure.message}
          />
        ) : (
          <ConnectorsPanel
            workspaceSlug={workspaceSlug}
            data={panelResult}
            heading="Available in the whole workspace"
            description="Every agent in this workspace can reach these, subject to the accountable person having connected their own account."
          />
        )}
      </section>

      {isAdmin && coverage && !isFailureEnvelope(coverage) && (
        <section className="mb-8 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-medium">Who has connected what</h2>
          <p className="mb-3 mt-1 text-xs text-black/50 dark:text-white/50">
            Whether each person has authorised their own account, and nothing about the account itself. An app nobody
            has connected is switched on and unusable — agents act with the credential of the person accountable for
            the run, so a connector with no connections behind it does nothing.
          </p>
          <ConnectionCoverage rows={coverage} />
        </section>
      )}

      {isAdmin && (
        <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="mb-3 text-sm font-medium">Recent activity</h2>
          <ConnectorActivity rows={audit} />
        </section>
      )}
    </main>
  )
}
