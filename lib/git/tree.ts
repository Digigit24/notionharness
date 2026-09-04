// R9.0 — reading a repository through git, never mirroring it.
//
// The alternative that was rejected: index the working tree into Postgres and
// keep it in sync. That buys a permanent staleness bug (the mirror is wrong
// for as long as it takes to notice a change) and it violates D0's "cache
// what is stable, never what is live". Git already IS the index, addressed by
// content, so the read path is git and the only thing cached is what git
// guarantees cannot change.
//
// Three consequences, all of them load-bearing:
//
//  - Listing is ONE level. `git ls-tree <commit>:<dir>` is O(directory), so a
//    repository carrying a 40,000-file `node_modules` costs nothing to browse
//    as long as nobody opens it. There is no recursive walk anywhere in here,
//    and adding one would undo the whole design.
//  - Reading is ONE blob, cached by its oid FOREVER. A blob oid is a hash of
//    the blob's content, so a cache entry keyed by it can never be stale.
//    Same for a directory listing keyed by `<commit>:<path>` — a commit sha
//    fixes the whole tree beneath it. This is free speed rather than a
//    trade-off, and it is the single largest latency decision in the unit.
//  - Change detection is a stat of a few files under `.git`, never a
//    recursive watcher. See `readRepoStamp`.
//
// Every path that arrives from a client goes through `normaliseRepoPath` and
// then `pathIsInside`. Traversal is the entire attack surface here: a `..`
// that slipped through would let a browser read arbitrary files off the
// machine running this app. Both checks are kept even though either alone
// would probably do, because "probably" is not the right standard for this.
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AppFailure, isAppFailure, raise, type FailureCode } from '@/lib/failures'
import { git, gitFailureFor, pathIsInside, GIT_ENV } from './repo'

const exec = promisify(execFile)

/** Files past this are described, never rendered. A megabyte of source is
 * already far past the point where a person reads it in a browser, and past
 * the point where highlighting it is cheap. */
export const MAX_BLOB_BYTES = 1024 * 1024

/** One directory's worth of rows. A repository can hold a directory with
 * tens of thousands of entries; the table says how many were left out rather
 * than shipping them all and letting the browser die. */
export const MAX_DIRECTORY_ENTRIES = 1000

/** Extra rows for untracked entries, on top of the tracked ones. Separate
 * budget so a directory full of build output cannot crowd out the real
 * files. */
const MAX_UNTRACKED_ENTRIES = 200

/** git's own rule: a NUL byte near the front means binary. Deliberately not
 * an extension allowlist — a `.txt` full of NULs is binary and a `.ts` is
 * text whatever its name, and extension lists are wrong about exactly the
 * files people care about. */
const BINARY_SNIFF_BYTES = 8192

/**
 * A path or ref this module refused to hand to git.
 *
 * An `AppFailure` rather than a bare `Error` so a rejected path arrives at
 * the browser as `invalid_input` (or `bad_ref` for a ref name) instead of a
 * digest — these sentences are the ones a person can actually act on, and
 * they were the ones being swallowed.
 */
export class RepoPathError extends AppFailure {
  constructor(message: string, code: FailureCode = 'invalid_input') {
    super({ code, message, retryable: false })
    this.name = 'RepoPathError'
  }
}

// ---------------------------------------------------------------------------
// Path and ref validation — the security boundary

/**
 * Turns a client-supplied path into a repo-relative POSIX path, or throws.
 *
 * Assume every path off the wire is hostile. The checks are deliberately
 * whitelist-shaped: anything that is not obviously an ordinary relative path
 * inside the repository is rejected rather than repaired, because "repair"
 * is where traversal bugs live (`....//` collapsing to `../`, and so on).
 *
 * A leading separator is dropped rather than refused, so `/lib/git` and
 * `lib/git` both mean the same repo-relative directory. That is deliberate —
 * a link written by hand or by an agent very often carries one — and it is
 * safe because the result is still relative and is re-checked against
 * `pathIsInside` before any read.
 *
 * `.git` is rejected at every position. It is never a tracked path so the
 * git read path could not reach it anyway — but the working-tree read path
 * uses `fs.readFile`, and `.git/config` is inside the repository directory,
 * so `pathIsInside` alone would happily allow reading it. That is a real
 * credential-adjacent leak and this is where it is closed.
 */
export function normaliseRepoPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') throw new RepoPathError('That path is not a string.')
  if (raw.includes('\0')) throw new RepoPathError('That path contains a NUL byte.')
  if (raw.length > 1024) throw new RepoPathError('That path is too long.')

  const parts = raw.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
  if (parts.length > 64) throw new RepoPathError('That path is nested too deeply.')

  for (const part of parts) {
    if (part === '.' || part === '..') throw new RepoPathError('That path escapes the repository.')
    // A leading colon is git pathspec magic (`:(exclude)…`). Pathspecs below
    // are already sent as `:(literal)`, so this is belt and braces — but a
    // path segment starting with `:` is not a legal filename on Windows
    // anyway, so nothing real is lost.
    if (part.startsWith(':')) throw new RepoPathError('That path is not a repository path.')
    if (/^[A-Za-z]:$/.test(part)) throw new RepoPathError('That path is absolute.')
    if (part.toLowerCase() === '.git') throw new RepoPathError('The .git directory is not browsable.')
  }
  return parts.join('/')
}

/**
 * A ref name we are willing to hand to git.
 *
 * `execFile` already makes shell injection impossible (argv array, no shell),
 * so this is about git's own argument grammar rather than the shell: a ref
 * beginning with `-` would be read as an option, and `^`/`~`/`:` would turn a
 * branch name into an arbitrary rev-spec. A branch, a tag, `HEAD` and a sha
 * all pass.
 */
export function normaliseRef(raw: string | null | undefined): string {
  const ref = (raw ?? '').trim() || 'HEAD'
  if (ref.length > 255) throw new RepoPathError('That ref name is too long.', 'bad_ref')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(ref) || ref.includes('..')) {
    throw new RepoPathError('That is not a valid branch, tag or commit.', 'bad_ref')
  }
  return ref
}

/** The second, independent traversal check, using the function ./repo already
 * exports for exactly this. Root resolves to the repo directory itself, which
 * `pathIsInside` (correctly) does not consider "inside" — hence the guard. */
async function resolveInsideRepo(repoDir: string, rel: string): Promise<string> {
  if (!rel) return repoDir
  const abs = join(repoDir, rel)
  if (!(await pathIsInside(repoDir, abs))) {
    throw new RepoPathError('That path is outside the repository.')
  }
  return abs
}

// ---------------------------------------------------------------------------
// Caches — keyed only on things git guarantees are immutable

/**
 * A tiny insertion-ordered LRU. Not a dependency: the whole contract is
 * "get, set, evict oldest", and a Map already preserves insertion order.
 */
class Lru<V> {
  private readonly map = new Map<string, V>()
  constructor(
    private readonly maxEntries: number,
    private readonly weigh: (value: V) => number = () => 1,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
  ) {}
  private weight = 0

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Re-insert so recently-read entries survive eviction.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key)
    if (existing !== undefined) {
      this.weight -= this.weigh(existing)
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.weight += this.weigh(value)
    while (this.map.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const evicted = this.map.get(oldest.value)
      if (evicted !== undefined) this.weight -= this.weigh(evicted)
      this.map.delete(oldest.value)
    }
  }
}

interface CachedBlob {
  size: number
  binary: boolean
  text: string | null
}

/**
 * Blob content by oid — the cache the whole unit is built around.
 *
 * Keyed by a content hash, so an entry can never be stale and never needs
 * invalidating. Bounded by bytes rather than entries because entries vary by
 * three orders of magnitude; 48 MB is roughly 48 of the largest file we will
 * ever hold and thousands of ordinary ones.
 *
 * Module scope, so it survives across requests in one server process and is
 * lost on restart. That is the correct lifetime: nothing in it is worth
 * persisting, since regenerating an entry is one `git cat-file`.
 */
const blobCache = new Lru<CachedBlob>(2000, (value) => (value.text ? value.text.length * 2 : value.size), 48 * 1024 * 1024)

interface CachedTree {
  entries: RepoEntry[]
  total: number
}

/** Directory listings by `<repo>\0<commit sha>\0<path>`. A commit sha fixes
 * every tree under it, so this is content-addressed too and equally safe to
 * keep forever. The working-tree status overlay is NOT in here — that part is
 * live and is re-read on every listing. */
const treeCache = new Lru<CachedTree>(600)

// ---------------------------------------------------------------------------
// Listing

export type RepoEntryType = 'blob' | 'tree' | 'commit'

/**
 * What the working tree has done to an entry, overlaid on the committed tree.
 * `contains-changes` is only ever set on a directory and means "something
 * under here differs", which is the only useful thing a folder row can say.
 */
export type RepoEntryStatus =
  | 'modified'
  | 'staged'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'untracked'
  | 'contains-changes'

export interface RepoEntry {
  name: string
  /** Repo-relative POSIX path. Safe to hand straight back to this module. */
  path: string
  type: RepoEntryType
  /** Bytes, for a blob. Null for a directory, a submodule, or an untracked
   * entry we could not stat. */
  size: number | null
  /** Blob or tree oid at this ref. Empty for an untracked entry — it has no
   * object yet, which is precisely why its content is never cached. */
  oid: string
  status: RepoEntryStatus | null
}

export interface RepoListing {
  ref: string
  /** The commit `ref` resolved to. Included so a caller can deep-link to an
   * immutable view of exactly what it rendered. */
  commit: string
  path: string
  entries: RepoEntry[]
  /** True when the directory holds more than `limit` entries. */
  truncated: boolean
  totalEntries: number
}

function parseLsTree(out: string, prefix: string): RepoEntry[] {
  const entries: RepoEntry[] = []
  for (const record of out.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    // `<mode> SP <type> SP <oid> SP*<size> TAB <name>` — `--long` right-pads
    // the size column, so a whitespace split is the documented way to read it.
    const meta = record.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 3) continue
    const [, type, oid, rawSize] = meta
    const name = record.slice(tab + 1)
    if (!name) continue
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue
    const size = Number(rawSize)
    entries.push({
      name,
      path: prefix ? `${prefix}/${name}` : name,
      type,
      size: type === 'blob' && Number.isFinite(size) ? size : null,
      oid,
      status: null,
    })
  }
  return entries
}

/** Directories first, then files, each case-insensitively by name — the order
 * every file browser uses and the only one that makes a long list scannable. */
function sortEntries(entries: RepoEntry[]): RepoEntry[] {
  return entries.sort((a, b) => {
    const aDir = a.type !== 'blob'
    const bDir = b.type !== 'blob'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

async function readTree(repoDir: string, commit: string, rel: string): Promise<CachedTree> {
  const key = `${repoDir}\0${commit}\0${rel}`
  const hit = treeCache.get(key)
  if (hit) return hit

  // `<commit>:<path>` addresses the subtree directly, so names come back
  // relative to it and one level deep with no pathspec involved. `-z` because
  // git otherwise C-quotes any name with a space or a non-ASCII character.
  const out = await git(repoDir, ['ls-tree', '--long', '-z', rel ? `${commit}:${rel}` : `${commit}:`])
  const all = sortEntries(parseLsTree(out, rel))
  const value: CachedTree = { entries: all.slice(0, MAX_DIRECTORY_ENTRIES), total: all.length }
  treeCache.set(key, value)
  return value
}

interface StatusOverlay {
  /** Repo-relative path -> porcelain XY code. Untracked directories keep
   * their trailing slash, exactly as git reports them. */
  codes: Map<string, string>
}

/**
 * `git status --porcelain`, scoped to one directory.
 *
 * Two choices worth stating. The pathspec is `:(literal)…`, which turns off
 * glob and magic interpretation entirely, so a filename containing `*` or a
 * leading `:` is a filename rather than an instruction. And untracked files
 * are `normal`, not `all`: `all` recurses into every untracked directory,
 * which on a repository with an unignored `node_modules` is the one call in
 * this file that could take seconds. `normal` reports the directory itself,
 * which is all a one-level listing can display anyway.
 *
 * `--no-renames` is there for the parser rather than for the display: with
 * renames on, a rename record is TWO NUL-separated fields and a reader that
 * does not know to consume the second one mis-parses everything after it.
 * A one-level listing has no use for the old path, so the safer format wins.
 *
 * This is the only part of a listing that is NOT cached, because it is the
 * only part that is live.
 */
async function readStatusOverlay(repoDir: string, rel: string): Promise<StatusOverlay> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames']
  if (rel) args.push('--', `:(literal)${rel}`)
  const codes = new Map<string, string>()
  let out: string
  try {
    out = await git(repoDir, args)
  } catch {
    // A status that fails (a repository mid-rebase with a locked index, say)
    // must not take the listing down with it. The rows then simply carry no
    // status, which is visibly "unknown" rather than falsely "clean".
    return { codes }
  }
  const fields = out.split('\0')
  for (const field of fields) {
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    if (path) codes.set(path, code)
  }
  return { codes }
}

/** git's XY porcelain code, collapsed to the one word a row can show. */
function statusFromCode(code: string): RepoEntryStatus | null {
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  if (code[1] === 'M' || code[1] === 'T') return 'modified'
  if (code[0] === 'A') return 'added'
  if (code[0] !== ' ' && code[0] !== '.') return 'staged'
  return null
}

export interface ListDirectoryOptions {
  ref?: string
  path?: string
  limit?: number
}

/**
 * One directory of a repository at one ref, with the working tree's changes
 * overlaid.
 *
 * Two git invocations: `rev-parse` to pin the ref to a commit, then either a
 * cached listing or one `ls-tree`, plus one scoped `status`. Never more, and
 * never anything proportional to the size of the repository.
 */
export async function listDirectory(repoDir: string, options: ListDirectoryOptions = {}): Promise<RepoListing> {
  const rel = normaliseRepoPath(options.path)
  await resolveInsideRepo(repoDir, rel)
  const ref = normaliseRef(options.ref)
  const limit = Math.max(1, Math.min(MAX_DIRECTORY_ENTRIES, options.limit ?? MAX_DIRECTORY_ENTRIES))

  // Deliberately NOT cached. `git rev-parse` reads one file and is among the
  // cheapest things git does; caching it would buy ten milliseconds and cost
  // the guarantee that an external commit shows up on the next look, which is
  // the one correctness property R9.5 asks for.
  const commit = (await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`], 10_000)).trim()

  // Independent of each other, so they go together rather than back to back.
  const [tree, overlay] = await Promise.all([readTree(repoDir, commit, rel), readStatusOverlay(repoDir, rel)])

  // One pass over the overlay to find which immediate subdirectories contain
  // a change, instead of re-scanning the whole overlay per directory row. At
  // the repository root on a dirty tree the overlay can hold thousands of
  // paths and the row list dozens of directories, and the naive version is
  // that product.
  const changedChildDirs = new Set<string>()
  const prefix = rel ? `${rel}/` : ''
  for (const key of overlay.codes.keys()) {
    if (prefix && !key.startsWith(prefix)) continue
    const remainder = key.slice(prefix.length)
    const slash = remainder.indexOf('/')
    if (slash > 0) changedChildDirs.add(remainder.slice(0, slash))
  }

  const tracked = tree.entries.map((entry) => ({ ...entry, status: entryStatus(entry, overlay, changedChildDirs) }))
  const untracked = collectUntracked(rel, overlay, new Set(tracked.map((entry) => entry.name)))
  await fillUntrackedSizes(repoDir, untracked)

  const entries = sortEntries([...tracked, ...untracked])
  return {
    ref,
    commit,
    path: rel,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || tree.total > tree.entries.length,
    totalEntries: tree.total + untracked.length,
  }
}

function entryStatus(entry: RepoEntry, overlay: StatusOverlay, changedChildDirs: Set<string>): RepoEntryStatus | null {
  const exact = overlay.codes.get(entry.path)
  if (exact) return statusFromCode(exact)
  if (entry.type === 'blob') return null
  // A directory row says "something under here changed", and nothing more
  // specific — a folder cannot be "modified".
  return changedChildDirs.has(entry.name) ? 'contains-changes' : null
}

/** Untracked entries that sit directly in this directory. Anything deeper
 * belongs to a subdirectory row, which already shows `contains-changes`. */
function collectUntracked(rel: string, overlay: StatusOverlay, takenNames: Set<string>): RepoEntry[] {
  const prefix = rel ? `${rel}/` : ''
  const out: RepoEntry[] = []
  for (const [path, code] of overlay.codes) {
    if (code !== '??') continue
    if (prefix && !path.startsWith(prefix)) continue
    const remainder = path.slice(prefix.length)
    if (!remainder) continue
    // git reports an untracked DIRECTORY with a trailing slash and does not
    // descend into it (`--untracked-files=normal`), which is exactly the one
    // level this browser wants.
    const isDir = remainder.endsWith('/')
    const name = isDir ? remainder.slice(0, -1) : remainder
    if (!name || name.includes('/')) continue
    if (takenNames.has(name)) continue
    out.push({
      name,
      path: prefix ? `${prefix}${name}` : name,
      type: isDir ? 'tree' : 'blob',
      size: null,
      oid: '',
      status: 'untracked',
    })
    if (out.length >= MAX_UNTRACKED_ENTRIES) break
  }
  return out
}

/** Sizes for untracked files, from the filesystem, since they have no blob.
 * Best-effort and parallel: a file deleted between the status call and this
 * one simply keeps a null size. */
async function fillUntrackedSizes(repoDir: string, entries: RepoEntry[]): Promise<void> {
  await Promise.all(
    entries
      .filter((entry) => entry.type === 'blob')
      .map(async (entry) => {
        try {
          const abs = await resolveInsideRepo(repoDir, entry.path)
          const info = await stat(abs)
          if (info.isFile()) entry.size = info.size
        } catch {
          // Leave it null.
        }
      }),
  )
}

// ---------------------------------------------------------------------------
// Reading one file

export type RepoBlobSource = 'ref' | 'worktree'

export interface RepoBlob {
  path: string
  ref: string
  source: RepoBlobSource
  /** Null for a working-tree read: an uncommitted file has no object. */
  oid: string | null
  size: number
  binary: boolean
  /** Null when the file is binary or over `MAX_BLOB_BYTES`. */
  text: string | null
  tooLarge: boolean
}

/** execFile with `encoding: 'buffer'`, because `git()` in ./repo decodes as
 * UTF-8 and a lossy decode destroys the NUL bytes that binary detection
 * depends on. Everything else about it matches `git()` deliberately. */
async function gitBuffer(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer,
      encoding: 'buffer',
      env: GIT_ENV,
    })
    return stdout
  } catch (err) {
    // The same classification `git()` applies, because these are the same
    // failures: a missing binary and a moved checkout look no different for
    // being read as bytes. Without this the one read that matters most — the
    // file you clicked — was the only one whose stderr was thrown away.
    throw await gitFailureFor(cwd, args, err)
  }
}

/** True for the one failure that is not really a failure: the file is larger
 * than the cap, which the caller turns into `tooLarge`. Recognised through
 * the classified code as well as the raw Node fields, since `gitBuffer` now
 * rejects with a `GitError`. */
function isMaxBufferError(err: unknown): boolean {
  if (err instanceof AppFailure) return err.code === 'repo_too_large'
  const e = err as { code?: string; message?: string }
  return e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer length exceeded/i.test(String(e?.message ?? ''))
}

function decodeBlob(buf: Buffer): { binary: boolean; text: string | null } {
  const sniff = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES))
  if (sniff.includes(0)) return { binary: true, text: null }
  // Strip a UTF-8 BOM: it is invisible in an editor and would otherwise show
  // up as a stray character at the head of the first line.
  return { binary: false, text: buf.toString('utf8').replace(/^﻿/, '') }
}

/** Whether a ref resolves at all, for the one place that has to tell a
 * missing ref from a missing path. Swallows the failure deliberately: this is
 * a question, and the answer is the boolean. */
async function refExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`], 10_000)
    return true
  } catch {
    return false
  }
}

export interface ReadBlobOptions {
  ref?: string
  path: string
  /** `worktree` reads the file from disk instead of from the object database
   * — the only way to see an uncommitted edit, and the only read here that is
   * never cached. */
  source?: RepoBlobSource
}

/**
 * One file's content.
 *
 * Committed path: `rev-parse` for the oid (one cheap call), then the cache,
 * then `cat-file blob`. A cache hit costs a single `rev-parse` and no read at
 * all — and because the key is a content hash, a hit is never wrong.
 *
 * Working-tree path: `fs.readFile`, and deliberately NOT cached. The file on
 * disk is live; caching it would reintroduce exactly the staleness bug that
 * R9.0 rejected mirroring to avoid.
 */
export async function readBlob(repoDir: string, options: ReadBlobOptions): Promise<RepoBlob> {
  const rel = normaliseRepoPath(options.path)
  if (!rel) throw new RepoPathError('A file path is required.')
  const abs = await resolveInsideRepo(repoDir, rel)
  const ref = normaliseRef(options.ref)
  const source: RepoBlobSource = options.source === 'worktree' ? 'worktree' : 'ref'

  if (source === 'worktree') {
    // `stat` throws a bare ENOENT whose message is a server-side absolute
    // path; a file that is not on disk is `not_found` and says so.
    const info = await stat(abs).catch((err: NodeJS.ErrnoException) => {
      throw new RepoPathError(`${rel} is not in the working tree.`, err.code === 'ENOENT' ? 'not_found' : 'invalid_input')
    })
    if (!info.isFile()) throw new RepoPathError('That path is not a file.')
    if (info.size > MAX_BLOB_BYTES) {
      return { path: rel, ref, source, oid: null, size: info.size, binary: false, text: null, tooLarge: true }
    }
    const buf = await readFile(abs)
    const decoded = decodeBlob(buf)
    return { path: rel, ref, source, oid: null, size: buf.length, ...decoded, tooLarge: false }
  }

  const oid = (
    await git(repoDir, ['rev-parse', '--verify', `${ref}:${rel}`], 10_000).catch(async (err: unknown) => {
      // `rev-parse <ref>:<path>` fails with the same "Needed a single
      // revision" for a ref that is gone and for a path that was never in
      // it. Asking git which one costs one more call, on the error path
      // only, and it is the difference between "that branch was deleted"
      // and "that file does not exist at this commit" — two problems with
      // nothing in common.
      if (isAppFailure(err) && err.code === 'bad_ref' && (await refExists(repoDir, ref))) {
        raise('not_found', `${rel} does not exist at ${ref}.`, { detail: err.detail })
      }
      throw err
    })
  ).trim()
  const cached = blobCache.get(oid)
  if (cached) {
    return { path: rel, ref, source, oid, size: cached.size, binary: cached.binary, text: cached.text, tooLarge: false }
  }

  let buf: Buffer
  try {
    // Cap the read rather than asking for the size first: one call instead of
    // two on the overwhelmingly common path, and the size is only needed at
    // all in the rare case where the cap is hit.
    buf = await gitBuffer(repoDir, ['cat-file', 'blob', oid], MAX_BLOB_BYTES + 1024)
  } catch (err) {
    if (!isMaxBufferError(err)) throw err
    const size = Number((await git(repoDir, ['cat-file', '-s', oid], 10_000)).trim())
    return { path: rel, ref, source, oid, size: Number.isFinite(size) ? size : MAX_BLOB_BYTES, binary: false, text: null, tooLarge: true }
  }

  if (buf.length > MAX_BLOB_BYTES) {
    return { path: rel, ref, source, oid, size: buf.length, binary: false, text: null, tooLarge: true }
  }

  const decoded = decodeBlob(buf)
  const value: CachedBlob = { size: buf.length, binary: decoded.binary, text: decoded.text }
  blobCache.set(oid, value)
  return { path: rel, ref, source, oid, size: buf.length, ...decoded, tooLarge: false }
}

// ---------------------------------------------------------------------------
// Change detection (R5.7's stat, reused)

/**
 * A cheap fingerprint of "has this repository moved".
 *
 * Two `fs.stat` calls and no git process at all, so a client can ask this on
 * an interval without it costing anything — which is what makes the polling
 * exception in D0 acceptable here. A recursive watcher over a repository is
 * the alternative and it is worse in every dimension: it walks the tree it is
 * trying to avoid walking, it dies on a large `node_modules`, and it needs
 * per-platform handling.
 *
 * What it catches: commits, staging, checkouts, merges, rebases (all rewrite
 * `.git/index`), branch switches (`HEAD`), and fetches (`FETCH_HEAD`,
 * `packed-refs`).
 *
 * What it does NOT catch, stated plainly rather than papered over: an update
 * to a single loose ref that is not the checked-out branch and not part of a
 * fetch — e.g. `git update-ref refs/heads/other <sha>` by hand. Browsing a
 * ref in that state shows the previous commit until something else moves. The
 * fix would be watching `refs/` recursively, which is the thing this function
 * exists to avoid; the trade is deliberate.
 */
export async function readRepoStamp(repoDir: string): Promise<string> {
  const gitDir = await resolveGitDir(repoDir)
  const parts = await Promise.all(
    ['HEAD', 'index', 'FETCH_HEAD', 'packed-refs'].map(async (name) => {
      try {
        const info = await stat(join(gitDir, name))
        return `${name}:${info.mtimeMs}:${info.size}`
      } catch {
        // Absent is a fact too — `FETCH_HEAD` appearing is itself a change.
        return `${name}:-`
      }
    }),
  )
  return parts.join('|')
}

/** In a linked worktree `.git` is a FILE holding `gitdir: <path>`, so the
 * naive `join(repoDir, '.git')` would stat a file that never changes and
 * report a repository that never moves. */
async function resolveGitDir(repoDir: string): Promise<string> {
  const dotGit = join(repoDir, '.git')
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) return dotGit
    const text = await readFile(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(text)
    if (match) return match[1].trim()
  } catch {
    // Fall through — a bare repository, or one we cannot read.
  }
  return dotGit
}
