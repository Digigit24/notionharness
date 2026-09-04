import { notFound } from 'next/navigation'
import { Blocks } from 'lucide-react'
import { getWorkspaceBySlug } from '@/lib/pages-cache'
import { Breadcrumbs } from '@/components/nav/breadcrumbs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { listMcpCatalog } from '@/lib/runtimes/hermes/mcp-catalog'

export const metadata = {
  title: 'MCP Connectors | NotionForge',
}

// Phase C, C2 — "a connector gallery is a grid view over data already on
// disk." Read-only browse of this machine's real Hermes MCP catalog (see
// lib/hermes/mcp-catalog.ts's own header comment) — no install action here;
// actually connecting a server is a real, separate write to the live
// install, out of scope for a first, safe pass.
export default async function McpCatalogPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  let entries: Awaited<ReturnType<typeof listMcpCatalog>> = []
  let loadError: string | null = null
  try {
    entries = await listMcpCatalog()
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not read the Hermes MCP catalog.'
  }

  return (
    <main className="w-full px-5 py-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-2"
          segments={[{ label: workspace.name, href: `/workspace/${workspace.slug}` }, { label: 'MCP Connectors' }]}
        />
        <h1 className="flex items-center gap-2 text-heading font-semibold">
          <Blocks size={20} />
          MCP Connectors
        </h1>
        <p className="mt-1 text-label text-faint">
          Nous-approved MCP server presets bundled with this machine&apos;s Hermes install. Browse-only — installing a
          connector is a real change to the live Hermes config, not built here yet.
        </p>
      </div>

      {loadError ? (
        <EmptyState icon={<Blocks />} title="Could not load the MCP catalog" description={loadError} />
      ) : entries.length === 0 ? (
        <EmptyState icon={<Blocks />} title="No presets found" description="Nothing under this install's optional-mcps/ directory." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {entries.map((entry) => (
            <li key={entry.slug}>
              <Card>
                <CardContent className="flex flex-col gap-2 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-label font-medium">{entry.name}</span>
                    {entry.authType && (
                      <Badge variant="outline" className="text-faint">
                        {entry.authType}
                      </Badge>
                    )}
                  </div>
                  <p className="text-caption text-faint">{entry.description}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-faint">
                    {entry.transportType && <span>Transport: {entry.transportType}</span>}
                    {entry.source && (
                      <a href={entry.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        Docs ↗
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
