'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { listRunsForProject, getRunUsageTotalsForRuns, type RunUsageTotals, type Run } from '@/lib/broker'
import { guard, raise, type WithFailure } from '@/lib/failures'
import type { Project, ProjectResource } from '@/payload-types'

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
    const runs = await listRunsForProject(projectId, { agentId: agentId ?? null })
    const usageByRun = await getRunUsageTotalsForRuns(runs.map((r) => r.id))
    return runs.map((run) => ({ run, usage: usageByRun[run.id] ?? { totalTokens: 0, totalCostTicks: 0 } }))
  })
}
