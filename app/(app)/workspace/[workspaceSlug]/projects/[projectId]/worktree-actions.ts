'use server'

import { revalidatePath } from 'next/cache'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import {
  createWorktreeRow,
  detachSessionsFromWorktree,
  getWorktree,
  listWorktreesForProject,
  markWorktreeStatus,
  type Worktree,
} from '@/lib/broker'
import {
  addWorktree,
  directoryExists,
  ghClone,
  isGitRepo,
  readBranches,
  readCommits,
  readGhStatus,
  readStatus,
  removeWorktree,
  resolveBaseRef,
  slugifyBranch,
  type GhStatus,
  type GitBranch,
  type GitCommit,
  type GitStatus,
} from '@/lib/git/repo'
import { guard, raise, type WithFailure } from '@/lib/failures'

/**
 * Project git bindings and worktrees.
 *
 * The rule this enforces, and the reason worktrees hang off a RESOURCE: a
 * project may bind several repositories and several plain folders, but a
 * worktree only exists inside an initialised git repository. A local folder
 * binding is still useful — an agent works in it directly — it just cannot
 * be branched.
 *
 * GitHub access is delegated to the user's own `gh` CLI rather than an OAuth
 * app of ours. `gh` already holds a credential in the OS keyring and `git`
 * already knows how to use it, so this app never stores a GitHub token, and
 * "connect GitHub" is `gh auth login` in the terminal the app already has.
 */

async function requireUser() {
  const user = await getCurrentPayloadUser()
  if (!user) raise('unauthenticated', 'You must be logged in.')
  return user
}

/** Where app-created clones live, so a user never has to invent a path. */
function projectsRoot(): string {
  return process.env.NOTIONFORGE_PROJECTS_ROOT || join(homedir(), '.notionforge', 'projects')
}

/** Where worktrees are checked out. Mirrors Orca's `~/orca/workspaces`
 * default: outside the repository, so a worktree is never mistaken for
 * untracked files inside it. */
function worktreesRoot(): string {
  return process.env.NOTIONFORGE_WORKTREE_ROOT || join(homedir(), '.notionforge', 'worktrees')
}

export interface ProjectResourceSummary {
  id: number
  kind: 'git_repo' | 'local_dir' | string
  path: string
  repoUrl: string | null
  defaultBranch: string | null
  role: string
  /** Present on disk right now. */
  exists: boolean
  /** A git repository, so it can host worktrees. */
  isRepo: boolean
}

async function loadResources(projectId: number): Promise<ProjectResourceSummary[]> {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'project-resources',
    where: { project: { equals: projectId } },
    sort: 'position',
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })

  return Promise.all(
    result.docs.map(async (doc) => {
      const path = typeof doc.path === 'string' ? doc.path : ''
      const exists = path ? await directoryExists(path) : false
      return {
        id: doc.id,
        kind: String(doc.kind ?? 'local_dir'),
        path,
        repoUrl: typeof doc.repoUrl === 'string' ? doc.repoUrl : null,
        defaultBranch: typeof doc.defaultBranch === 'string' ? doc.defaultBranch : null,
        role: String(doc.role ?? 'reference'),
        exists,
        // Asked of the filesystem, not inferred from `kind`: a binding
        // labelled `git_repo` whose clone failed is not a repo, and a folder
        // someone ran `git init` in is.
        isRepo: exists ? await isGitRepo(path) : false,
      }
    }),
  )
}

export interface ProjectGitOverview {
  resources: ProjectResourceSummary[]
  worktrees: Worktree[]
  gh: GhStatus
  /** Live git facts per worktree path, best-effort. */
  statuses: Record<number, GitStatus | null>
}

export async function getProjectGitOverview(projectId: number): Promise<WithFailure<ProjectGitOverview>> {
  return guard(async () => {
    await requireUser()
    const [resources, worktrees, gh] = await Promise.all([
      loadResources(projectId),
      listWorktreesForProject(projectId),
      readGhStatus(),
    ])

    // Read every worktree's status in parallel; one broken checkout must not
    // stop the others from rendering.
    const entries = await Promise.all(
      worktrees.map(async (worktree) => {
        if (worktree.status !== 'active') return [worktree.id, null] as const
        const present = await directoryExists(worktree.path)
        if (!present) return [worktree.id, null] as const
        return [worktree.id, await readStatus(worktree.path).catch(() => null)] as const
      }),
    )

    return { resources, worktrees, gh, statuses: Object.fromEntries(entries) }
  })
}

export interface WorktreeDetail {
  worktree: Worktree
  status: GitStatus | null
  commits: GitCommit[]
  branches: GitBranch[]
  missing: boolean
}

export async function getWorktreeDetail(worktreeId: number): Promise<WithFailure<WorktreeDetail>> {
  return guard(async () => {
    await requireUser()
    const worktree = await getWorktree(worktreeId)
    if (!worktree) raise('not_found', 'That worktree no longer exists.')
    const present = await directoryExists(worktree.path)
    if (!present) return { worktree, status: null, commits: [], branches: [], missing: true }

    const [status, commits, branches] = await Promise.all([
      readStatus(worktree.path).catch(() => null),
      readCommits(worktree.path, 20).catch(() => []),
      readBranches(worktree.path).catch(() => []),
    ])
    return { worktree, status, commits, branches, missing: false }
  })
}

/** Binds an existing directory on this machine. */
export async function addLocalResource(input: {
  workspaceSlug: string
  projectId: number
  path: string
  role?: string
}): Promise<WithFailure<ProjectResourceSummary[]>> {
  return guard(async () => {
    await requireUser()
    const path = input.path.trim()
    if (!path) raise('invalid_input', 'A path is required.')
    if (!(await directoryExists(path))) {
      raise('not_found', `No directory at ${path} on the machine running Hermes.`)
    }
    const repo = await isGitRepo(path)

    const payload = await getPayloadClient()
    await payload.create({
      collection: 'project-resources',
      data: {
        project: input.projectId,
        // The filesystem decides which this is, not the person filling the form.
        kind: repo ? 'git_repo' : 'local_dir',
        path,
        defaultBranch: repo ? await resolveBaseRef(path).catch(() => null) : null,
        role: input.role ?? 'reference',
        exists: true,
        lastVerifiedAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/projects/${input.projectId}`)
    return loadResources(input.projectId)
  })
}

/** Clones a GitHub repository with `gh` and binds the result. */
export async function addGitHubResource(input: {
  workspaceSlug: string
  projectId: number
  repo: string
  role?: string
}): Promise<WithFailure<ProjectResourceSummary[]>> {
  return guard(async () => {
    await requireUser()
    const repo = input.repo.trim()
    // `gh repo clone` accepts `owner/name` or a full URL; anything else is a
    // typo worth catching before a two-minute clone attempt.
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) && !/^https?:\/\//.test(repo) && !/^git@/.test(repo)) {
      raise('invalid_input', 'Give a repository as owner/name, or a full URL.')
    }
    const gh = await readGhStatus()
    // `unknown`, not `git_missing`: git may be perfectly healthy here — it is
    // the GitHub CLI that is absent — and `FailureCode` has no code for that.
    // Inventing one of the git codes would make a log lie about which tool
    // broke, so this stays honest until the shared list gains a name for it.
    if (!gh.installed) raise('unknown', 'The GitHub CLI (gh) is not installed on this machine.')
    if (!gh.authenticated) {
      raise('unknown', 'GitHub is not connected. Run `gh auth login` on this machine, then try again.')
    }

    const name = repo.replace(/\.git$/, '').split('/').slice(-2).join('/')
    const target = join(projectsRoot(), ...name.split('/'))
    if (await directoryExists(target)) {
      if (!(await isGitRepo(target))) raise('conflict', `${target} already exists and is not a git repository.`)
    } else {
      await ghClone(repo, target)
    }

    const payload = await getPayloadClient()
    await payload.create({
      collection: 'project-resources',
      data: {
        project: input.projectId,
        kind: 'git_repo',
        path: target,
        repoUrl: /^https?:\/\/|^git@/.test(repo) ? repo : `https://github.com/${name}`,
        defaultBranch: await resolveBaseRef(target).catch(() => null),
        role: input.role ?? 'primary',
        exists: true,
        lastVerifiedAt: new Date().toISOString(),
      } as never,
      overrideAccess: true,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/projects/${input.projectId}`)
    return loadResources(input.projectId)
  })
}

export async function createProjectWorktree(input: {
  workspaceSlug: string
  projectId: number
  resourceId: number
  name: string
  baseRef?: string
  sessionId?: number | null
}): Promise<WithFailure<Worktree>> {
  return guard(async () => {
    const user = await requireUser()
    const resources = await loadResources(input.projectId)
    const resource = resources.find((entry) => entry.id === input.resourceId)
    if (!resource) raise('not_found', 'That resource does not belong to this project.')
    if (!resource.exists) raise('not_found', `${resource.path} is not on this machine.`)
    if (!resource.isRepo) {
      // The distinction that makes this feature honest rather than confusing.
      raise('not_a_repository', 'Only a git repository can have worktrees. This binding is a plain folder.')
    }

    const slug = slugifyBranch(input.name)
    // Unique per project so two projects binding the same repo cannot collide,
    // and stamped so a repeated name is a new checkout rather than an error.
    const unique = `${slug}-${Date.now().toString(36).slice(-4)}`
    const branch = `agent/${unique}`
    const path = join(worktreesRoot(), String(input.projectId), unique)

    const created = await addWorktree(resource.path, {
      path,
      branch,
      baseRef: input.baseRef || resource.defaultBranch || undefined,
      fetch: true,
    })

    const row = await createWorktreeRow({
      projectId: input.projectId,
      resourceId: resource.id,
      path: created.path,
      branch: created.branch,
      baseRef: created.baseRef,
      displayName: input.name.trim() || slug,
      createdBySessionId: input.sessionId ?? null,
      createdBy: user.id,
    })
    revalidatePath(`/workspace/${input.workspaceSlug}/projects/${input.projectId}`)
    return row
  })
}

export async function removeProjectWorktree(input: {
  workspaceSlug: string
  projectId: number
  worktreeId: number
  force?: boolean
  deleteBranch?: boolean
}): Promise<WithFailure<void>> {
  return guard(async () => {
    await requireUser()
    const worktree = await getWorktree(input.worktreeId)
    if (!worktree) return
    if (worktree.projectId !== input.projectId) raise('forbidden', 'That worktree belongs to another project.')

    const resources = await loadResources(input.projectId)
    const resource = resources.find((entry) => entry.id === worktree.resourceId)

    if (resource?.exists && (await directoryExists(worktree.path))) {
      try {
        await removeWorktree(resource.path, {
          path: worktree.path,
          branch: worktree.branch,
          force: input.force,
          deleteBranch: input.deleteBranch,
        })
      } catch (err) {
        // git refuses to remove a dirty worktree without --force, and saying so
        // is far better than a silent failure that leaves the row behind.
        const message = err instanceof Error ? err.message : String(err)
        if (/contains modified or untracked files/i.test(message) && !input.force) {
          // git's own stderr rides along as `detail` — it names the files, which
          // is the one thing the person deciding whether to force actually wants.
          raise('worktree_dirty', 'This worktree has uncommitted changes. Remove it with force to discard them.', {
            detail: message,
          })
        }
        throw err
      }
    }

    await detachSessionsFromWorktree(worktree.id)
    await markWorktreeStatus(worktree.id, 'removed')
    revalidatePath(`/workspace/${input.workspaceSlug}/projects/${input.projectId}`)
  })
}
