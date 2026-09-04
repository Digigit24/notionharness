// R5.6 — reading GitHub's CI verdict, and the logs behind a red one.
//
// Everything here goes through `runGh` from `./repo`, for the reason stated
// there: `gh` already owns a GitHub credential in the OS keyring, so this app
// holds no token of its own and adding one would be a new secret to leak for
// no capability gained. Nothing below ever sees or forwards a token.
//
// The field names used in the `--json` flags were read off `gh pr checks
// --help`, `gh run list --help` and `gh run view --help` on gh 2.97.0 and
// confirmed against live repositories, not guessed. If a future gh renames
// one, the call fails loudly with gh's own "unknown JSON field" message
// rather than silently returning nothing — which is why the errors below are
// surfaced verbatim instead of being flattened into "could not read checks".
import { runGh } from './repo'

/**
 * gh's own five-way classification of a check's `state`, documented in
 * `gh pr checks --help`. Reused verbatim rather than re-derived from `state`,
 * because gh already knows that (say) `NEUTRAL` and `SKIPPED` are both
 * "skipping" and that a required-but-stale check is a failure.
 */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

export interface CheckItem {
  /** The check's name as GitHub reports it — the job name for Actions. */
  name: string
  /** Empty string for checks that are not GitHub Actions (gh returns `""`,
   * not null, for a Vercel or CircleCI status). */
  workflow: string | null
  bucket: CheckBucket
  /** gh's raw state (`FAILURE`, `IN_PROGRESS`, …). Kept for the tooltip: the
   * bucket is what we colour by, the state is what a person recognises. */
  state: string | null
  link: string | null
  /** Parsed out of `link`. Null for a non-Actions check. */
  runId: number | null
  /** Parsed out of `link`. Null when we only know the run, which is the case
   * for the branch fallback below. */
  jobId: number | null
  /**
   * Whether `gh run view --log-failed` can produce logs for this.
   *
   * False for every third-party status check. This matters and is not a
   * detail: on a real PR the failing check is quite often a Vercel or
   * CircleCI status whose link points at that vendor's dashboard, and gh has
   * no way to read those logs. Claiming otherwise and then handing an agent
   * an empty prompt is exactly the failure this flag exists to prevent.
   */
  logsAvailable: boolean
}

export interface ChecksSnapshot {
  /** False when gh is missing, unauthenticated, or the repository has no
   * GitHub remote. `reason` then says which, for the disabled chip's title. */
  available: boolean
  reason: string | null
  /** Where the verdict came from. A pull request is the better source (it is
   * what a reviewer is looking at); the branch fallback exists so a checkout
   * with no PR yet still shows its CI. */
  source: 'pull-request' | 'branch' | null
  branch: string | null
  items: CheckItem[]
  counts: Record<CheckBucket, number>
  /**
   * True when GitHub was reachable and simply had nothing to say — no pull
   * request and no workflow runs for this branch.
   *
   * Deliberately distinct from "everything passed". A branch that has never
   * run CI is not a green branch, and colouring it green is the single most
   * misleading thing this component could do.
   */
  empty: boolean
}

const EMPTY_COUNTS: Record<CheckBucket, number> = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 }

function unavailable(reason: string): ChecksSnapshot {
  return {
    available: false,
    reason,
    source: null,
    branch: null,
    items: [],
    counts: { ...EMPTY_COUNTS },
    empty: true,
  }
}

/**
 * Runs a `gh` command and returns stdout even when gh exits non-zero.
 *
 * `gh pr checks` documents exit code 8 for pending checks and exits 1 when a
 * branch has no pull request, and `runGh` (correctly, for its other callers)
 * rejects on any non-zero exit. Node attaches `stdout`/`stderr` to that
 * rejection — verified against gh 2.97.0 — so the useful output is still
 * there. Observed on the way in: with `--json`, gh 2.97.0 exits 0 even when
 * checks have failed, so the non-zero path is really about the *absence* of
 * a pull request rather than about failure; the handling stays anyway,
 * because relying on an undocumented exit code is how this breaks silently
 * on the next gh release.
 */
async function ghOutput(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; failed: boolean; missing: boolean; overflowed: boolean }> {
  try {
    return { stdout: await runGh(cwd, args, timeoutMs), stderr: '', failed: false, missing: false, overflowed: false }
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string; stderr?: string; message?: string }
    const stderr = String(e.stderr ?? e.message ?? '')
    const missing = e.code === 'ENOENT' || /is not recognized|command not found/i.test(stderr)
    // `runGh` uses execFile's default 1 MB stdout buffer (unlike `git()`,
    // which raises it to 16 MB). A failing test suite's `--log-failed` output
    // can pass that, and Node then kills gh and hands back the FIRST 1 MB.
    // That matters because the caller keeps the tail of a log and tells the
    // agent it is the end of it — which would be false here.
    const overflowed =
      e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer length exceeded/i.test(stderr)
    return { stdout: String(e.stdout ?? ''), stderr: stderr.trim(), failed: true, missing, overflowed }
  }
}

/** gh's stderr for the two states that are normal rather than broken. */
const NO_PULL_REQUEST = /no pull requests found|no open pull requests/i
/** gh exits 1 with this when a pull request exists but nothing has reported a
 * check against its head commit yet. That is "no checks", not "gh is broken",
 * so it falls through to the branch runs and ends as an empty snapshot. */
const NO_CHECKS_REPORTED = /no checks reported/i
const NOT_AUTHENTICATED = /gh auth login|not logged|authentication|HTTP 401/i
const NO_GITHUB_REMOTE = /no git remotes|none of the git remotes|not a git repository|could not determine.*repository/i

/** `https://github.com/o/r/actions/runs/<runId>/job/<jobId>` — the only link
 * shape gh can fetch logs for. Anything else is a third-party status. */
const ACTIONS_LINK = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/

export function parseActionsLink(link: string | null | undefined): { runId: number; jobId: number | null } | null {
  if (!link) return null
  const match = ACTIONS_LINK.exec(link)
  if (!match) return null
  return { runId: Number(match[1]), jobId: match[2] ? Number(match[2]) : null }
}

interface RawPrCheck {
  name?: string
  workflow?: string
  bucket?: string
  state?: string
  link?: string
}

interface RawRun {
  databaseId?: number
  conclusion?: string
  status?: string
  workflowName?: string
  headBranch?: string
  url?: string
}

/** `gh run list` reports status and conclusion separately; this collapses the
 * pair into the same buckets `gh pr checks` uses, so the UI has one vocabulary
 * whichever source answered. */
function bucketForRun(run: RawRun): CheckBucket {
  if (run.status !== 'completed') return 'pending'
  switch (run.conclusion) {
    case 'success':
      return 'pass'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'fail'
    case 'cancelled':
      return 'cancel'
    default:
      // `skipped`, `neutral`, `action_required`, `stale` — none of which is a
      // failure and none of which is a pass.
      return 'skipping'
  }
}

function tally(items: CheckItem[]): Record<CheckBucket, number> {
  const counts = { ...EMPTY_COUNTS }
  for (const item of items) counts[item.bucket] += 1
  return counts
}

/**
 * The CI verdict for a checkout.
 *
 * Asks about the pull request first and falls back to the branch's own
 * workflow runs. Two `gh` invocations at worst, only on an explicit read —
 * this is never on a render path and never on an interval (D0).
 */
export async function readChecks(dir: string, branch: string | null): Promise<ChecksSnapshot> {
  const pr = await ghOutput(dir, ['pr', 'checks', '--json', 'name,workflow,bucket,state,link'], 45_000)

  if (pr.missing) return unavailable('The GitHub CLI (gh) is not installed on this machine.')
  if (pr.failed && NOT_AUTHENTICATED.test(pr.stderr)) {
    return unavailable('gh is not signed in to GitHub. Run `gh auth login` in a terminal.')
  }
  if (pr.failed && NO_GITHUB_REMOTE.test(pr.stderr)) {
    return unavailable('This checkout has no GitHub remote, so there is no CI to read.')
  }

  const parsed = parseJsonArray<RawPrCheck>(pr.stdout)
  if (parsed && parsed.length > 0) {
    const items = parsed.map((raw): CheckItem => {
      const actions = parseActionsLink(raw.link)
      return {
        name: raw.name?.trim() || 'Check',
        workflow: raw.workflow?.trim() || null,
        bucket: (raw.bucket as CheckBucket) ?? 'pending',
        state: raw.state ?? null,
        link: raw.link ?? null,
        runId: actions?.runId ?? null,
        jobId: actions?.jobId ?? null,
        logsAvailable: actions !== null,
      }
    })
    return {
      available: true,
      reason: null,
      source: 'pull-request',
      branch,
      items,
      counts: tally(items),
      empty: false,
    }
  }

  // No pull request (or one with no checks attached yet). Fall back to the
  // branch's own runs rather than reporting nothing: an agent working in a
  // worktree usually pushes long before anyone opens a PR, and that is
  // precisely when a red chip is most useful.
  if (pr.failed && !NO_PULL_REQUEST.test(pr.stderr) && !NO_CHECKS_REPORTED.test(pr.stderr) && pr.stderr) {
    return unavailable(pr.stderr.split('\n')[0].slice(0, 200))
  }
  if (!branch) {
    return unavailable('This checkout has no branch (detached HEAD), so there is no CI to look up.')
  }

  const runs = await ghOutput(
    dir,
    ['run', 'list', '--branch', branch, '--limit', '20', '--json', 'databaseId,conclusion,status,workflowName,url'],
    45_000,
  )
  if (runs.missing) return unavailable('The GitHub CLI (gh) is not installed on this machine.')
  if (runs.failed && NOT_AUTHENTICATED.test(runs.stderr)) {
    return unavailable('gh is not signed in to GitHub. Run `gh auth login` in a terminal.')
  }
  const rawRuns = parseJsonArray<RawRun>(runs.stdout)
  if (!rawRuns) {
    return unavailable(runs.stderr.split('\n')[0].slice(0, 200) || 'gh returned nothing for this branch.')
  }

  // `gh run list` returns every attempt, newest first. Only the newest run of
  // each workflow is the current verdict — showing a superseded failure next
  // to its own passing re-run would be a red chip that lies.
  const newestByWorkflow = new Map<string, RawRun>()
  for (const run of rawRuns) {
    const key = run.workflowName ?? String(run.databaseId ?? '')
    if (!newestByWorkflow.has(key)) newestByWorkflow.set(key, run)
  }

  const items = [...newestByWorkflow.values()].map((run): CheckItem => ({
    name: run.workflowName?.trim() || `Run ${run.databaseId ?? '?'}`,
    workflow: run.workflowName?.trim() || null,
    bucket: bucketForRun(run),
    state: run.conclusion ?? run.status ?? null,
    link: run.url ?? null,
    runId: run.databaseId ?? null,
    // A run knows nothing about which of its jobs failed until we ask; the
    // log fetch below handles a null jobId by reading the whole run's failed
    // steps, which is one gh call rather than two.
    jobId: null,
    logsAvailable: typeof run.databaseId === 'number',
  }))

  return {
    available: true,
    reason: null,
    source: 'branch',
    branch,
    items,
    counts: tally(items),
    empty: items.length === 0,
  }
}

function parseJsonArray<T>(text: string): T[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[')) return null
  try {
    const value = JSON.parse(trimmed)
    return Array.isArray(value) ? (value as T[]) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Logs

/**
 * How much log text a composed prompt may carry, in characters.
 *
 * Set by a hard downstream limit, not by taste: `sendSessionMessage` in
 * `work/actions.ts` rejects a prompt over 20,000 characters. The header,
 * the failing-check list and the closing instruction have to fit in the same
 * budget, so the logs get 12,000 and the rest is head-room. A prompt that is
 * silently refused after the person clicked the button is worse than a
 * shorter one that is honest about the cut.
 */
export const LOG_CHAR_BUDGET = 12_000

/** More than a few failing jobs and no individual log is long enough to be
 * useful. Better to hand over three readable ones and say how many were left
 * out than six unreadable fragments. */
export const MAX_LOG_JOBS = 3

export interface FailedJobLog {
  /** The check these logs belong to. */
  name: string
  link: string | null
  /** Compacted log text — empty when `error` is set. */
  text: string
  /** True when the log was cut. The cut always keeps the END of the log. */
  truncated: boolean
  /** Characters dropped from the front, so the UI can state the size of what
   * is missing rather than implying the log was complete. */
  omittedChars: number
  /**
   * True when gh's own stdout buffer overflowed, so what we hold is the
   * FRONT of the log and its real end was never read. Kept separate from
   * `truncated` because the prompt promises the tail, and promising the tail
   * while handing over the middle is worse than saying nothing.
   */
  headOnly: boolean
  error: string | null
}

/**
 * Turns `gh run view --log-failed` output into something worth a prompt slot.
 *
 * gh prints one line per log line as `<job>\t<step>\t<ISO timestamp> <text>`.
 * On a real failing job that prefix is 60-100 characters of the *same* two
 * strings repeated on every line, which at a 12,000 character budget is most
 * of the budget spent on nothing. Stripping it and emitting a header when the
 * step changes is lossless — every dropped character is recoverable from the
 * header above it.
 *
 * Timestamps are dropped as well, and that one is a genuine (small) loss:
 * they cost roughly a third of the remaining budget and almost never matter
 * for reading a build failure. The composed prompt says they were removed,
 * so nobody reads the absence as "the log had no timestamps".
 *
 * No secret redaction is attempted here. GitHub Actions already masks
 * registered secrets as `***` before the log ever leaves their servers, and a
 * second, weaker pass of our own would mostly serve to make the output look
 * sanitised when it is not.
 */
export function compactFailedLog(raw: string): string {
  const lines = raw.replace(/^﻿/, '').split('\n')
  const out: string[] = []
  let currentStep: string | null = null

  for (const line of lines) {
    if (!line.trim()) continue
    const columns = line.split('\t')
    let step: string | null = null
    let body = line
    if (columns.length >= 3) {
      step = columns[1]?.trim() || null
      body = columns.slice(2).join('\t')
    }
    // The BOM sits after the tabs on the very first line, not at the start.
    body = body.replace(/^﻿/, '')
    body = body.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
    if (step && step !== currentStep) {
      currentStep = step
      out.push(`--- step: ${step}`)
    }
    out.push(body)
  }
  return out.join('\n')
}

/**
 * Fetches the failed steps of one job (or of a whole run, when `jobId` is
 * null) and compacts them to fit `maxChars`.
 *
 * Never throws: a job whose logs have expired, or a third-party check with no
 * logs at all, comes back with `error` set so the prompt can say which check
 * it could not read instead of quietly omitting it.
 */
export async function readFailedJobLog(
  dir: string,
  item: Pick<CheckItem, 'name' | 'link' | 'runId' | 'jobId' | 'logsAvailable'>,
  maxChars: number,
): Promise<FailedJobLog> {
  const base: FailedJobLog = { name: item.name, link: item.link ?? null, text: '', truncated: false, omittedChars: 0, headOnly: false, error: null }
  if (!item.logsAvailable || item.runId === null) {
    return {
      ...base,
      error: 'This check is not a GitHub Actions job, so gh cannot read its logs. Open the link to see them.',
    }
  }

  // `--job` addresses one job and needs no run id; without it the run id is
  // required and gh returns the failed steps of every job in the run. Both
  // are a single call, which is why the branch fallback does not first ask
  // which job failed.
  const args = item.jobId !== null
    ? ['run', 'view', '--job', String(item.jobId), '--log-failed']
    : ['run', 'view', String(item.runId), '--log-failed']

  // Generous, because gh downloads and unzips the run's log archive here.
  // It is on an explicit click, never on a render (D0), and the caller shows
  // a working state for the duration.
  const result = await ghOutput(dir, args, 90_000)
  if (result.failed && !result.stdout.trim()) {
    return { ...base, error: result.stderr.split('\n')[0].slice(0, 200) || 'gh could not fetch these logs.' }
  }

  const headOnly = result.overflowed
  const compacted = compactFailedLog(result.stdout)
  if (!compacted.trim()) {
    // A "failing" check with no failed-step output is real: a job cancelled
    // before it started, or logs GitHub has already expired.
    return { ...base, error: 'GitHub returned no failed-step output for this job.' }
  }
  if (compacted.length <= maxChars) return { ...base, text: compacted, headOnly }
  // The end of a log is where a build actually gives up, so the tail is the
  // half worth keeping when only half fits.
  return {
    ...base,
    text: compacted.slice(compacted.length - maxChars),
    truncated: true,
    omittedChars: compacted.length - maxChars,
    headOnly,
  }
}

export interface FailingChecksPrompt {
  prompt: string
  /** True when any log was cut, so the UI can say so beside the button
   * rather than letting a truncated log look complete. */
  capped: boolean
  /** Failing checks that were left out of the prompt entirely because
   * `MAX_LOG_JOBS` was reached. Named, not silently dropped. */
  omittedChecks: string[]
  logs: FailedJobLog[]
}

/**
 * Composes the prompt that hands a failing job's logs to an agent.
 *
 * Deliberately assembled here rather than by a model call: the useful content
 * is the log, and paying a round trip to have something rephrase text we
 * already have would be a latency cost for no information (the same reasoning
 * as `suggestCommitMessage` in `work/git-actions.ts`).
 */
export async function composeFailingChecksPrompt(
  dir: string,
  snapshot: ChecksSnapshot,
): Promise<FailingChecksPrompt | null> {
  const failing = snapshot.items.filter((item) => item.bucket === 'fail')
  if (failing.length === 0) return null

  // Several failing checks routinely belong to the same Actions run; reading
  // that run's failed steps twice would spend the budget on a duplicate.
  const seen = new Set<string>()
  const unique = failing.filter((item) => {
    const key = `${item.runId ?? 'x'}:${item.jobId ?? 'x'}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Checks gh can actually read go first. Observed on a live PR: three of the
  // four failing checks were Vercel statuses whose links point at Vercel's
  // dashboard, and taking them in GitHub's order would have spent every log
  // slot on checks that have no logs. They still appear in the list above —
  // nothing is hidden, only deprioritised.
  const ordered = [...unique].sort((a, b) => Number(b.logsAvailable) - Number(a.logsAvailable))
  const chosen = ordered.slice(0, MAX_LOG_JOBS)
  const omittedChecks = ordered.slice(MAX_LOG_JOBS).map((item) => item.name)
  const perJob = Math.floor(LOG_CHAR_BUDGET / chosen.length)

  // Independent gh invocations, so they go together rather than serialising
  // three archive downloads back to back (D0).
  const logs = await Promise.all(chosen.map((item) => readFailedJobLog(dir, item, perJob)))

  const lines: string[] = []
  lines.push(
    `CI is failing on ${snapshot.branch ?? 'this branch'}${
      snapshot.source === 'pull-request' ? ' (checks on its pull request)' : ' (workflow runs for the branch)'
    }.`,
  )
  lines.push('')
  lines.push('Failing checks:')
  for (const item of failing) {
    lines.push(`- ${item.name}${item.workflow && item.workflow !== item.name ? ` (${item.workflow})` : ''}${item.link ? ` — ${item.link}` : ''}`)
  }
  if (omittedChecks.length > 0) {
    lines.push('')
    lines.push(`Logs below cover ${chosen.length} of them. Not included: ${omittedChecks.join(', ')}.`)
  }
  lines.push('')
  lines.push(
    'Logs come from `gh run view --log-failed`, so they are the failed steps only. The repeated job/step columns and the per-line timestamps have been stripped to fit; step boundaries are marked `--- step:`.',
  )

  for (const log of logs) {
    lines.push('')
    lines.push(`===== ${log.name} =====`)
    if (log.error) {
      lines.push(`(logs unavailable: ${log.error})`)
      continue
    }
    if (log.headOnly) {
      lines.push(
        '(this log was too large to read in full — gh was cut off after 1 MB, so what follows is from the MIDDLE of the log and the real end of the run is missing)',
      )
    } else if (log.truncated) {
      lines.push(`(the first ${log.omittedChars} characters of this log were cut; what follows is the END of it)`)
    }
    lines.push(log.text)
  }

  lines.push('')
  lines.push('Work out why this failed and fix it in this checkout. If the logs are not enough to be sure, say what else you need rather than guessing.')

  return {
    prompt: lines.join('\n'),
    capped: logs.some((log) => log.truncated),
    omittedChecks,
    logs,
  }
}
