'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { listRunsForProject, getRunUsageTotalsForRuns, type RunUsageTotals, type Run } from '@/lib/broker'
import { guard, raise, type WithFailure } from '@/lib/failures'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { requireAccess, type Verb } from '@/lib/permissions'
import type { Project, ProjectResource } from '@/payload-types'

/**
 * PHASE 0 — every action in this file wrote or read with `overrideAccess: true`
 * and no check of any kind. A server action is a public POST endpoint with a
 * generated URL, so naming any `projectId` was enough to rename somebody
 * else's project, list the repositories and directories it is bound to, bind a
 * new one, or delete one.
 *
 * The project's OWN workspace is resolved from the id, never taken from the
 * caller. `workspaceSlug` is present in most of these signatures but it only
 * ever drives `revalidatePath`, and trusting it for authorisation would mean a
 * caller could pair a workspace they administer with a project they do not.
 *
 * `objectType: 'project'` rather than `'workspace'`, so a per-object grant
 * (`collections/AccessGrants.ts`) genuinely raises access the way it is meant
 * to — a `viewer` in the workspace who was granted `editor` on this one
 * project can work in it, which is the case the grant table exists for.
 */
async function requireProject(projectId: number, verb: Verb): Promise<{ project: Project; userId: number }> {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You are not signed in.')
  const payload = await getPayloadClient()
  const project = await payload
    .findByID({ collection: 'projects', id: projectId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!project) raise('not_found', 'That project no longer exists.')
  const workspaceId = typeof project.workspace === 'number' ? project.workspace : project.workspace.id
  await requireAccess({ userId: user.id, workspaceId, verb, objectType: 'project', objectId: projectId })
  return { project, userId: user.id }
}

/** The resource's project, resolved from the resource itself. Passing the
 * `projectId` in and trusting it would let a caller pair a project they may
 * write with a resource belonging to one they may not. */
async function requireResourceProject(resourceId: number, verb: Verb): Promise<void> {
  const payload = await getPayloadClient()
  const resource = await payload
    .findByID({ collection: 'project-resources', id: resourceId, depth: 0, overrideAccess: true, disableErrors: true })
    .catch(() => null)
  if (!resource) raise('not_found', 'That resource no longer exists.')
  const projectId = typeof resource.project === 'number' ? resource.project : resource.project.id
  await requireProject(projectId, verb)
}

// ROADMAP B-1 (project detail) — the project's own fields are deliberately
// minimal today (collections/Projects.ts: name/workspace/icon/description
// only — no repo/directory binding, no defaultAgent/defaultRuntime, no
// members, no archive/status). This action only ever writes fields that
// actually exist; it does not invent a schema the Settings tab would then
// have to fake.
export async function updateProject({
  projectId,
  workspaceSlug,
  data,
}: {
  projectId: number
  workspaceSlug: string
  data: Partial<Pick<Project, 'name' | 'icon' | 'description'>>
}): Promise<WithFailure<Project>> {
  return guard(async () => {
    await requireProject(projectId, 'write')
    const payload = await getPayloadClient()
    const project = await payload.update({
      collection: 'projects',
      id: projectId,
      data,
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
    revalidatePath(`/workspace/${workspaceSlug}/projects`)
    return project
  })
}

/** Resources — a project's bound git repos / local directories
 * (collections/ProjectResources.ts). Closes the gap that tab's own "Files"
 * empty state already names ("Projects have no repo/directory binding field
 * at all") now that the schema is actually migrated and registered
 * (Phase C, C1.1 — see AGENTS.md). Deliberately list/create/delete only for
 * this pass, no inline edit — matches the size of every other CRUD form
 * added this session (runtime profiles, projects themselves). */
export async function listProjectResources(projectId: number): Promise<WithFailure<ProjectResource[]>> {
  return guard(async () => {
    await requireProject(projectId, 'read')
    const payload = await getPayloadClient()
    const result = await payload.find({
      collection: 'project-resources',
      where: { project: { equals: projectId } },
      sort: 'position',
      limit: 100,
      depth: 0,
      overrideAccess: true,
    })
    return result.docs
  })
}

export async function createProjectResource({
  projectId,
  workspaceSlug,
  data,
}: {
  projectId: number
  workspaceSlug: string
  data: Pick<ProjectResource, 'kind' | 'role' | 'path' | 'repoUrl' | 'defaultBranch' | 'writable'>
}): Promise<WithFailure<ProjectResource>> {
  return guard(async () => {
    // `administer`, not `write`: this names a real directory or git repository
    // on the machine running the app, which agents are then allowed to read and
    // (when `writable`) modify. Choosing what this host exposes is the same
    // decision as choosing a connector or a runtime.
    await requireProject(projectId, 'administer')
    if (data.role === 'primary') {
      const existingPrimary = await getPayloadClient().then((payload) =>
        payload.find({
          collection: 'project-resources',
          where: { project: { equals: projectId }, role: { equals: 'primary' } },
          limit: 1,
          depth: 0,
          overrideAccess: true,
        }),
      )
      if (existingPrimary.docs.length > 0) {
        raise('conflict', 'This project already has a primary resource — only one is allowed. Delete or change the existing one first.')
      }
    }
    const payload = await getPayloadClient()
    const resource = await payload.create({
      collection: 'project-resources',
      data: { ...data, project: projectId },
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
    return resource
  })
}

export async function deleteProjectResource({
  resourceId,
  projectId,
  workspaceSlug,
}: {
  resourceId: number
  projectId: number
  workspaceSlug: string
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireResourceProject(resourceId, 'administer')
    const payload = await getPayloadClient()
    await payload.delete({ collection: 'project-resources', id: resourceId, overrideAccess: true })
    revalidatePath(`/workspace/${workspaceSlug}/projects/${projectId}`)
  })
}

export interface ProjectRunRow {
  run: Run
  usage: RunUsageTotals
}

/** Runs tab data, callable from the client so the agent filter dropdown
 * doesn't need a full page navigation. Cost rollup is derived by the caller
 * by summing `usage` across the returned rows — no separate query needed
 * for the filtered case, only for the always-visible unfiltered 30-day
 * figure on the Overview tab (`getProjectUsageRollup`, called server-side). */
export async function getProjectRuns({
  projectId,
  agentId,
}: {
  projectId: number
  agentId?: number | null
}): Promise<WithFailure<ProjectRunRow[]>> {
  return guard(async () => {
    await requireProject(projectId, 'read')
    const runs = await listRunsForProject(projectId, { agentId: agentId ?? null })
    const usageByRun = await getRunUsageTotalsForRuns(runs.map((r) => r.id))
    return runs.map((run) => ({ run, usage: usageByRun[run.id] ?? { totalTokens: 0, totalCostTicks: 0 } }))
  })
}
