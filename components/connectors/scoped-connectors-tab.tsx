import { isFailureEnvelope } from '@/lib/failures'
import { ConnectorsPanel } from '@/components/connectors/connectors-panel'
import { getConnectorPanel, type ConnectorScopeType } from '@/app/(app)/workspace/[workspaceSlug]/settings/connectors/actions'

/**
 * The Connectors tab's content, for a project or an agent.
 *
 * A SERVER COMPONENT PASSED AS TAB CONTENT, not a client component that fetches
 * on mount. `DetailLayout` renders every tab's content into the tree at once
 * and toggles visibility, so this load happens with the rest of the page rather
 * than after a click — which is what makes the tab open instantly instead of
 * showing a spinner the first time somebody presses it (D0).
 *
 * WHY IT EXISTS RATHER THAN THE TWO PAGES EACH DOING THE FETCH. Both pages need
 * the same three lines and the same failure branch. Duplicating them is how the
 * project tab and the agent tab end up disagreeing about what to show when
 * Composio is unreachable — which is a state a person will hit, because the
 * whole point of a connector is that it depends on somebody else's server.
 *
 * THE FAILURE IS RENDERED IN PLACE. `getConnectorPanel` RETURNS its failure
 * (`lib/failures.ts`), so an unreachable Composio or a missing key produces a
 * sentence inside the tab rather than taking the whole detail page down with an
 * error boundary — losing the tasks, runs and settings beside it to explain one
 * missing API key would be a very poor trade.
 */
export async function ScopedConnectorsTab({
  workspaceSlug,
  scopeType,
  scopeId,
  heading,
  description,
}: {
  workspaceSlug: string
  scopeType: Exclude<ConnectorScopeType, 'workspace'>
  scopeId: number
  heading: string
  description: string
}) {
  const result = await getConnectorPanel({ workspaceSlug, scopeType, scopeId })

  if (isFailureEnvelope(result)) {
    return (
      <div className="p-6">
        <p className="max-w-xl text-sm text-destructive">{result.__failure.message}</p>
        {result.__failure.detail && (
          <p className="mt-1 max-w-xl text-xs text-black/50 dark:text-white/50">{result.__failure.detail}</p>
        )}
      </div>
    )
  }

  return (
    <div className="p-6">
      <ConnectorsPanel workspaceSlug={workspaceSlug} data={result} heading={heading} description={description} />
    </div>
  )
}
