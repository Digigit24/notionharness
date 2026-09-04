import { notFound } from 'next/navigation'

import { ArtifactsInbox } from '@/components/artifacts/artifacts-inbox'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { getBrokerPool } from '@/lib/broker'
import { listArtifacts, getArtifact, type ArtifactKind } from '@/lib/artifacts'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'

/**
 * R8.4 — the Artifacts section.
 *
 * "A top-level sidebar entry listing loose artifacts newest first, and
 * nothing else. Its job is to be emptied."
 *
 * The list is `project: 'loose'` and that is not a default a filter can
 * override: an artifact that has been filed into a project already has a
 * home, and showing it here too would make filing feel like a copy instead of
 * the move R8.3 says it is. Filters narrow this list; none of them widens it.
 *
 * No board, no grouping, no saved views. This is a triage list.
 */
export default async function ArtifactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>
  searchParams: Promise<{ kind?: string; agent?: string; session?: string; artifact?: string }>
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams])
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) notFound()

  const payload = await getPayloadClient()
  const kindFilter: ArtifactKind | undefined = query.kind === 'page' || query.kind === 'html' ? query.kind : undefined
  const agentFilter = Number(query.agent) || undefined
  const sessionFilter = Number(query.session) || undefined
  const openId = Number(query.artifact) || null

  const [artifacts, agentsResult, projectsResult] = await Promise.all([
    listArtifacts(payload, {
      workspaceId: workspace.id,
      project: 'loose',
      kind: kindFilter,
      agentId: agentFilter,
      sessionId: sessionFilter,
      limit: 200,
    }),
    // The author filter's options. Every agent in the workspace, not the
    // distinct set that has actually authored something: a "distinct author"
    // query would be a second pass over the artifact table to build a list
    // that is almost always the same one, and the empty result is honest
    // either way.
    payload.find({
      collection: 'agents',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'projects',
      where: { workspace: { equals: workspace.id } },
      sort: 'name',
      limit: 200,
      depth: 0,
      overrideAccess: true,
    }),
  ])

  // Page previews and session titles: ONE query each for the whole list, not
  // one per card. R8.4 asks for a first-lines preview from
  // `pages.plainTextContent` and says it "costs no extra read" — that is only
  // true if it stays a single batched read, and `select` keeps `docState`
  // (the heavy column, a whole Yjs snapshot) out of the response.
  const pageIds = artifacts.map((a) => a.pageId).filter((id): id is number => id != null)
  const sessionIds = [...new Set(artifacts.map((a) => a.sessionId).filter((id): id is number => id != null))]

  const [pagesResult, sessionRows] = await Promise.all([
    pageIds.length === 0
      ? Promise.resolve({ docs: [] as Array<{ id: number; plainTextContent?: string | null; icon?: string | null }> })
      : payload.find({
          collection: 'pages',
          where: { id: { in: pageIds } },
          limit: pageIds.length,
          depth: 0,
          select: { plainTextContent: true, icon: true },
          overrideAccess: true,
        }),
    sessionIds.length === 0
      ? Promise.resolve({ rows: [] as Array<{ id: string; title: string | null }> })
      : // Raw pg, because `chat_sessions` is a broker table and has no Payload
        // collection to `find` through (see lib/broker/sessions.ts).
        getBrokerPool()
          .query<{ id: string; title: string | null }>(`SELECT id, title FROM chat_sessions WHERE id = ANY($1::bigint[])`, [
            sessionIds,
          ])
          .catch(() => ({ rows: [] as Array<{ id: string; title: string | null }> })),
  ])

  const previewByPageId = new Map<number, { preview: string; icon: string | null }>()
  for (const page of pagesResult.docs) {
    const text = (page.plainTextContent ?? '').trim()
    previewByPageId.set(page.id, {
      // Two lines is what a card can show without becoming a document
      // viewer; the panel is where the whole thing is read.
      preview: text.split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 220),
      icon: page.icon ?? null,
    })
  }

  const sessionTitleById = new Map<number, string>()
  for (const row of sessionRows.rows) {
    sessionTitleById.set(Number(row.id), row.title?.trim() || `Session ${row.id}`)
  }

  const agentNameById = new Map<number, string>()
  for (const agent of agentsResult.docs) agentNameById.set(agent.id, agent.name)

  const cards = artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    pageId: artifact.pageId,
    preview: artifact.pageId == null ? null : (previewByPageId.get(artifact.pageId)?.preview ?? null),
    icon: artifact.pageId == null ? null : (previewByPageId.get(artifact.pageId)?.icon ?? null),
    agentId: artifact.createdByAgentId,
    agentName: artifact.createdByAgentId == null ? null : (agentNameById.get(artifact.createdByAgentId) ?? null),
    sessionId: artifact.sessionId,
    sessionTitle: artifact.sessionId == null ? null : (sessionTitleById.get(artifact.sessionId) ?? null),
  }))

  // The panel's content is resolved server-side, in the same request that
  // rendered the list. The editor needs `initialDocState` at mount, so
  // fetching it from the client would be the same round trip moved later and
  // paid after a visible empty frame (D0).
  let panel: React.ComponentProps<typeof ArtifactPanel>['artifact'] = null
  if (openId != null) {
    const artifact = await getArtifact(payload, openId)
    if (artifact && artifact.workspaceId === workspace.id) {
      const page =
        artifact.pageId == null
          ? null
          : await payload
              .findByID({ collection: 'pages', id: artifact.pageId, depth: 0, overrideAccess: true, disableErrors: true })
              .catch(() => null)
      panel = {
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        pageId: artifact.pageId,
        htmlContent: artifact.htmlContent,
        pageTitle: page?.title ?? artifact.name,
        pageDocState: page?.docState ?? null,
        pageLocked: page?.isLocked ?? false,
      }
    }
  }

  return (
    <main className="w-full px-5 py-8">
      <ArtifactsInbox
        workspaceSlug={workspace.slug}
        artifacts={cards}
        agents={agentsResult.docs.map((agent) => ({ id: agent.id, name: agent.name }))}
        sessions={[...sessionTitleById.entries()].map(([id, title]) => ({ id, title }))}
        projects={projectsResult.docs.map((project) => ({ id: project.id, name: project.name, icon: project.icon ?? null }))}
        kind={kindFilter ?? ''}
        agent={query.agent ?? ''}
        session={query.session ?? ''}
      />
      <ArtifactPanel workspaceId={workspace.id} workspaceSlug={workspace.slug} artifact={panel} />
    </main>
  )
}
