'use server'

import { revalidatePath } from 'next/cache'

import { fileArtifact } from '@/lib/artifacts'
import { getPayloadClient } from '@/lib/payload'
import { getWorkspaceBySlug } from '@/lib/pages-cache'

/**
 * R8.4's primary action, and R8.3's move.
 *
 * Takes a list rather than a single id because bulk select is part of the
 * spec and because filing five artifacts one server action at a time would be
 * five round trips for one gesture. A single artifact is just a list of one,
 * so there is one code path and not two.
 *
 * `projectId: null` un-files, sending the artifact back to the inbox. That is
 * the same operation in the other direction and deliberately not a separate
 * action — R8.3 says clearing the project sends it back, so making "unfile" a
 * different verb would be inventing an asymmetry the rule does not have.
 */
export async function fileArtifacts({
  workspaceSlug,
  artifactIds,
  projectId,
}: {
  workspaceSlug: string
  artifactIds: number[]
  projectId: number | null
}): Promise<{ filed: number }> {
  if (artifactIds.length === 0) return { filed: 0 }

  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) throw new Error('Workspace not found.')

  const payload = await getPayloadClient()

  // Ownership is checked here, per artifact, before anything moves. The
  // client sends ids and the ids are not trustworthy; `fileArtifact` only
  // checks that the destination project matches the artifact's workspace,
  // which would happily move an artifact from another workspace into a
  // project of this one if this loop did not exist.
  //
  // ONE query for the whole selection, not one per id: this runs on a human's
  // click and a per-id `findByID` would put a bulk file behind N round trips
  // to a remote database before the first row moved.
  const found = await payload.find({
    collection: 'artifacts',
    where: { id: { in: artifactIds }, workspace: { equals: workspace.id } },
    limit: artifactIds.length,
    depth: 0,
    select: {},
    overrideAccess: true,
  })
  const owned = found.docs.map((doc) => doc.id)
  if (owned.length === 0) throw new Error('None of those artifacts are in this workspace.')

  // Sequential, not `Promise.all`: each call writes the artifact and then its
  // page, and a bulk file is a handful of rows a human selected by hand, not
  // a batch job. Concurrency here would buy a few milliseconds and cost the
  // ability to say which one failed.
  for (const id of owned) {
    await fileArtifact(payload, id, projectId)
  }

  revalidatePath(`/workspace/${workspaceSlug}/artifacts`)
  if (projectId != null) revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
  return { filed: owned.length }
}
