'use server'

// R9 — the server side of the repository browser.
//
// Everything a client can reach is in this file, and every entry point starts
// with `resolveRepo`. That is not decoration: a recent review of this
// repository found three cross-workspace holes where an action trusted a
// client-supplied id, and this feature would turn that class of bug into
// "read any file on the server's disk". The chain checked here is
// user -> workspace membership -> project -> resource -> repo directory, with
// every link verified against the database rather than against what the
// caller said. Path safety on top of that lives in lib/git/tree.ts.
import { getPayloadClient } from '@/lib/payload'
import { getCurrentPayloadUser } from '@/lib/current-user'
import { directoryExists, isGitRepo, readBranches } from '@/lib/git/repo'
import {
  listDirectory,
  normaliseRepoPath,
  readBlob,
  readRepoStamp,
  type RepoBlob,
  type RepoListing,
} from '@/lib/git/tree'
import { highlightFile, renderMarkdown, type HighlightedFile } from '@/lib/git/highlight'

export interface RepoBinding {
  resourceId: number
  path: string
  /** The last segment of the path — what a person calls the repository. */
  name: string
  defaultBranch: string
}

interface ResolvedRepo extends RepoBinding {
  workspaceId: number
  projectId: number
  /** Every git binding on this project, for the repository picker.
   *
   * Taken from the `kind` column rather than by stat-ing each path: a project
   * with six bindings would otherwise cost six filesystem round trips on
   * every listing, to populate a dropdown. Only the binding actually being
   * read is verified against the filesystem, which is where being wrong would
   * matter. */
  bindings: RepoBinding[]
}

/**
 * The single scoping gate.
 *
 * `resourceId` is optional so the first load does not need one; when omitted,
 * the project's first usable git binding is chosen HERE, from rows the
 * database says belong to this project. When supplied it is matched against
 * the same list, so a resource id belonging to another workspace's project
 * finds no match and the call fails — it is never passed to git.
 */
async function resolveRepo(input: {
  workspaceSlug: string
  projectId: number
  resourceId?: number | null
}): Promise<ResolvedRepo> {
  const user = await getCurrentPayloadUser()
  if (!user) throw new Error('You must be logged in.')

  const payload = await getPayloadClient()

  const workspaces = await payload.find({
    collection: 'workspaces',
    where: { slug: { equals: input.workspaceSlug } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const workspace = workspaces.docs[0]
  if (!workspace) throw new Error('That workspace does not exist.')

  // `getWorkspaceBySlug` resolves a slug and nothing else — it does not check
  // who is asking. Membership is therefore checked here rather than assumed,
  // which is exactly the step the earlier cross-workspace bugs skipped.
  const ownerId = typeof workspace.owner === 'number' ? workspace.owner : workspace.owner?.id
  const memberIds = (workspace.members ?? []).map((member) => (typeof member === 'number' ? member : member.id))
  if (ownerId !== user.id && !memberIds.includes(user.id)) {
    throw new Error('You do not have access to that workspace.')
  }

  if (!Number.isInteger(input.projectId)) throw new Error('That project does not exist.')
  const project = await payload.findByID({
    collection: 'projects',
    id: input.projectId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  if (!project) throw new Error('That project does not exist.')
  const projectWorkspaceId = typeof project.workspace === 'number' ? project.workspace : project.workspace?.id
  if (projectWorkspaceId !== workspace.id) throw new Error('That project does not exist.')

  const resources = await payload.find({
    collection: 'project-resources',
    where: { project: { equals: project.id } },
    sort: 'position',
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })

  const candidates = resources.docs.filter((doc) => typeof doc.path === 'string' && doc.path.length > 0)
  const chosen =
    input.resourceId != null
      ? candidates.find((doc) => doc.id === input.resourceId)
      : // No explicit choice: prefer a binding the row already claims is a
        // repository, so the common case avoids stat-ing every folder.
        candidates.find((doc) => doc.kind === 'git_repo') ?? candidates[0]
  if (!chosen) throw new Error('This project is not bound to a repository.')

  const path = String(chosen.path)
  // The filesystem decides, not the `kind` column: a binding labelled
  // `git_repo` whose clone failed is not a repo, and browsing it would put a
  // git error in front of the user instead of an explanation.
  if (!(await directoryExists(path))) throw new Error(`${path} is not on this machine.`)
  if (!(await isGitRepo(path))) throw new Error(`${path} is not a git repository.`)

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    ...toBinding(chosen.id, path, chosen.defaultBranch),
    bindings: candidates
      .filter((doc) => doc.kind === 'git_repo' || doc.id === chosen.id)
      .map((doc) => toBinding(doc.id, String(doc.path), doc.defaultBranch)),
  }
}

function toBinding(resourceId: number, path: string, defaultBranch: unknown): RepoBinding {
  return {
    resourceId,
    path,
    name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path,
    defaultBranch: typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : 'HEAD',
  }
}

// ---------------------------------------------------------------------------
// Reads

export interface RepoBrowserRef {
  name: string
  current: boolean
}

export interface RepoDirectoryPayload {
  kind: 'directory'
  binding: RepoBinding
  bindings: RepoBinding[]
  listing: RepoListing
  /** Bounded ref list for the picker. Never every ref in the repository. */
  refs: RepoBrowserRef[]
  stamp: string
}

export interface RepoFilePayload {
  kind: 'file'
  binding: RepoBinding
  bindings: RepoBinding[]
  blob: RepoBlob
  /** Present only for text files small enough to render. */
  code: HighlightedFile | null
  /** Server-rendered markdown, for a `.md` file only (R9.3). */
  markdownHtml: string | null
  /** Raw source for the sandboxed iframe, for an `.html` file only (R9.3).
   * Deliberately the unmodified file: the iframe is what contains it. */
  htmlPreview: string | null
  refs: RepoBrowserRef[]
  stamp: string
}

export type RepoViewPayload = RepoDirectoryPayload | RepoFilePayload

export interface RepoViewRequest {
  workspaceSlug: string
  projectId: number
  resourceId?: number | null
  ref?: string | null
  path?: string | null
  /** Which of the two things a path can be. The caller knows, because it got
   * the entry's type from a listing; asking git twice to find out would be a
   * round trip spent on something already known. */
  kind?: 'directory' | 'file'
  /** Read the file from disk rather than from the ref — the only way to see
   * an uncommitted edit. */
  worktree?: boolean
}

/** Branches for the picker, capped. A repository with 4,000 remote branches
 * is not unusual and none of them belong in a dropdown. */
const MAX_REFS = 60

async function loadRefs(repoDir: string): Promise<RepoBrowserRef[]> {
  try {
    const branches = await readBranches(repoDir)
    const refs = branches.slice(0, MAX_REFS).map((branch) => ({ name: branch.name, current: branch.current }))
    // HEAD first so the default view is always selectable by name, including
    // in a detached checkout where no branch is current.
    return [{ name: 'HEAD', current: !refs.some((ref) => ref.current) }, ...refs]
  } catch {
    return [{ name: 'HEAD', current: true }]
  }
}

/** Rendered previews are for files a person opens deliberately; a 400 KB
 * README is a generated artefact, not a document. */
const MAX_PREVIEW_BYTES = 400_000

/**
 * One view of the repository — a directory listing or a file.
 *
 * Everything the client needs comes back in one call, including the refs and
 * the change stamp, so navigating a directory is one round trip rather than
 * three.
 */
export async function readRepoView(request: RepoViewRequest): Promise<RepoViewPayload> {
  const repo = await resolveRepo(request)
  const binding: RepoBinding = {
    resourceId: repo.resourceId,
    path: repo.path,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
  }
  const bindings = repo.bindings
  const path = normaliseRepoPath(request.path)
  const ref = request.ref || repo.defaultBranch

  if (request.kind === 'file' && path) {
    const [blob, refs, stamp] = await Promise.all([
      readBlob(repo.path, { ref, path, source: request.worktree ? 'worktree' : 'ref' }),
      loadRefs(repo.path),
      readRepoStamp(repo.path),
    ])

    const lower = path.toLowerCase()
    const isMarkdown = /\.(md|markdown)$/.test(lower)
    const isHtml = /\.(html?)$/.test(lower)
    const renderable = blob.text !== null && blob.size <= MAX_PREVIEW_BYTES

    return {
      kind: 'file',
      binding,
      bindings,
      blob,
      // Highlighted even for a file that will open in preview, because the
      // Source tab beside it must not cost a second round trip. Both come off
      // one blob read, and the blob is cached by oid, so the marginal cost is
      // the tokenise and nothing else.
      code: blob.text !== null ? await highlightFile(blob.text, path) : null,
      markdownHtml: isMarkdown && renderable && blob.text ? renderMarkdown(blob.text) : null,
      htmlPreview: isHtml && renderable && blob.text ? blob.text : null,
      refs,
      stamp,
    }
  }

  const [listing, refs, stamp] = await Promise.all([
    listDirectory(repo.path, { ref, path }),
    loadRefs(repo.path),
    readRepoStamp(repo.path),
  ])
  return { kind: 'directory', binding, bindings, listing, refs, stamp }
}

// Note for anyone extending this file: a `'use server'` module may only
// export async functions (and types). Re-exporting a constant such as
// `MAX_BLOB_BYTES` from here is a build error, which is why the client
// formats sizes itself instead of importing the cap.

/**
 * The change-detection poll (R9.0 / R5.7).
 *
 * Two `fs.stat` calls, no git process, no database write — cheap enough that
 * a client can ask every few seconds while the tab is actually visible. This
 * is the case D0's polling exception was written for: the thing being watched
 * is a directory on disk, outside the database, with no push channel to
 * subscribe to. A recursive watcher would be the alternative and it is worse
 * — it walks the tree this whole unit is designed never to walk.
 */
export async function readRepoStampFor(input: {
  workspaceSlug: string
  projectId: number
  resourceId?: number | null
}): Promise<string> {
  const repo = await resolveRepo(input)
  return readRepoStamp(repo.path)
}
