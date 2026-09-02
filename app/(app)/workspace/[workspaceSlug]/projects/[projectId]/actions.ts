'use server'

import { revalidatePath } from 'next/cache'
import { getPayloadClient } from '@/lib/payload'
import { listRunsForProject, getRunUsageTotalsForRuns, type RunUsageTotals, type Run } from '@/lib/broker'
import type { Project } from '@/payload-types'

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
}): Promise<Project> {
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
}): Promise<ProjectRunRow[]> {
  const runs = await listRunsForProject(projectId, { agentId: agentId ?? null })
  const usageByRun = await getRunUsageTotalsForRuns(runs.map((r) => r.id))
  return runs.map((run) => ({ run, usage: usageByRun[run.id] ?? { totalTokens: 0, totalCostTicks: 0 } }))
}
