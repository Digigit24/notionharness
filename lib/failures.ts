/**
 * R12-P1 — the failure spine.
 *
 * WHY THIS EXISTS, PROVEN RATHER THAN ASSUMED.
 *
 * A server action that throws does not deliver its message to the browser in
 * a production build. Measured against this app's own `npm start`, with a
 * temporary action that threw `PROBE_SENTINEL_MESSAGE`, the entire response
 * body was:
 *
 *     0:{"a":"$@1","f":"","b":"…"}
 *     1:E{"digest":"4214928911"}
 *
 * No message. React masks it deliberately — a thrown server error could carry
 * a connection string or a file path — and hands the client a digest instead.
 * Which means every `throw new Error('That channel no longer exists.')` in
 * this codebase, and every `catch (err) { toast({ description: err.message }) }`
 * that reads it, has been showing users a generic React sentence in
 * production while showing us the real one in development. The sentences were
 * written with care and none of them arrived.
 *
 * So a failure a person is meant to READ has to be RETURNED, not thrown.
 *
 * THE SHAPE, AND WHY IT IS NOT `{ ok, data }`.
 *
 * The obvious envelope — `{ ok: true, data: T } | { ok: false, error }` —
 * would mean editing the success path of every action and every caller in the
 * app on the same day. This uses a union with a single reserved key instead:
 *
 *     type WithFailure<T> = T | { __failure: FailureInfo }
 *
 * An action's success shape is untouched, so a caller that has not been
 * migrated yet keeps compiling and keeps working. A caller that HAS been
 * migrated wraps its call in `unwrap()`, which returns the value or throws a
 * real Error **in the browser**, where the message survives — so every
 * existing `catch (err) { err.message }` toast starts showing the real
 * sentence with no change to the catch block itself.
 *
 * Migration is therefore per call site, in any order, with no flag day.
 */
import { logger } from '@/lib/logger'

/**
 * Stable machine strings. A UI branches on these; a log is grepped for them.
 *
 * The same choice `runtime-profiles.lastProbeCode` already made, for the same
 * reason: a sentence is for a person and changes freely, a code is for a
 * program and must not.
 */
export type FailureCode =
  // Authorisation and existence — the two most common, and the two most often
  // confused. `not_found` is also returned where a thing exists but is not
  // yours, so probing ids cannot tell the difference.
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  // Infrastructure this app owns.
  | 'db_unavailable'
  | 'timeout'
  // Runtimes and agents.
  | 'runtime_not_installed'
  | 'runtime_handshake_failed'
  | 'agent_unavailable'
  | 'run_not_retryable'
  | 'spend_cap_reached'
  // Git and worktrees. These are R12-P5's vocabulary and are declared here so
  // there is exactly one list.
  | 'git_missing'
  | 'not_a_repository'
  | 'bad_ref'
  | 'worktree_missing'
  | 'worktree_dirty'
  | 'repo_too_large'
  // The honest default. Never invented for something we could have named.
  | 'unknown'

export interface FailureInfo {
  code: FailureCode
  /** Written for the person who hit it. Complete sentence, no stack, no ids
   * they cannot act on. */
  message: string
  /** The raw underlying text when there is one — git's stderr, a driver's
   * error. The single most useful string on the screen, and the one we have
   * been throwing away. */
  detail?: string
  /** Whether trying the same thing again could plausibly work. Drives whether
   * a UI offers "Retry" or "Go back", and whether the dispatcher requeues. */
  retryable: boolean
}

/** The envelope. One reserved key, chosen so it cannot collide with a real
 * field on any action's success shape. */
export interface FailureEnvelope {
  __failure: FailureInfo
}

export type WithFailure<T> = T | FailureEnvelope

/**
 * A failure raised deliberately, with a code.
 *
 * Still an Error, so `throw` keeps working where throwing is right (a route
 * handler, a script, a server component covered by an error boundary — all
 * three DO deliver the message). `guard()` below turns it into an envelope
 * when it happens inside an action.
 */
export class AppFailure extends Error {
  readonly code: FailureCode
  readonly detail?: string
  readonly retryable: boolean

  constructor(info: FailureInfo) {
    super(info.message)
    this.name = 'AppFailure'
    this.code = info.code
    this.detail = info.detail
    this.retryable = info.retryable
  }

  toInfo(): FailureInfo {
    return { code: this.code, message: this.message, detail: this.detail, retryable: this.retryable }
  }
}

export function isAppFailure(value: unknown): value is AppFailure {
  return value instanceof AppFailure
}

export function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  return typeof value === 'object' && value !== null && '__failure' in value
}

/** Build a failure. `retryable` defaults per code rather than per call site,
 * so two places raising `db_unavailable` cannot disagree about whether it is
 * worth retrying. */
export function failure(code: FailureCode, message: string, options?: { detail?: string; retryable?: boolean }): AppFailure {
  return new AppFailure({
    code,
    message,
    detail: options?.detail,
    retryable: options?.retryable ?? DEFAULT_RETRYABLE.has(code),
  })
}

/** Raise one. Returns `never`, so TypeScript narrows after it the way it does
 * after `throw`. */
export function raise(code: FailureCode, message: string, options?: { detail?: string; retryable?: boolean }): never {
  throw failure(code, message, options)
}

const DEFAULT_RETRYABLE = new Set<FailureCode>([
  'db_unavailable',
  'timeout',
  'agent_unavailable',
  'runtime_handshake_failed',
  'worktree_missing',
])

/** Wrap an already-built failure as an envelope an action can return. */
export function failureEnvelope(info: FailureInfo): FailureEnvelope {
  return { __failure: info }
}

/**
 * Turn anything thrown into a failure that can be shown.
 *
 * A plain `Error` keeps its message: those sentences are good and were only
 * ever lost in transit. What it gains is a code, so a caller can branch, and
 * a `retryable` flag, so a UI knows whether to offer a retry.
 */
export function toFailureInfo(err: unknown): FailureInfo {
  if (isAppFailure(err)) return err.toInfo()
  if (isFailureEnvelope(err)) return err.__failure
  const message = err instanceof Error ? err.message : String(err ?? 'Something went wrong.')
  return { code: inferCode(message), message, retryable: false }
}

/**
 * A best-effort code for a message we did not raise ourselves.
 *
 * Deliberately small. Guessing widely here would produce codes that look
 * authoritative and are not; anything unrecognised stays `unknown`, which is
 * an honest answer and reads correctly in a log.
 */
function inferCode(message: string): FailureCode {
  const text = message.toLowerCase()
  if (text.includes('logged in') || text.includes('unauthenticated')) return 'unauthenticated'
  if (text.includes('not yours') || text.includes('do not have access') || text.includes('belongs to another')) {
    return 'forbidden'
  }
  if (text.includes('no longer exists') || text.includes('not found')) return 'not_found'
  if (/\benoent\b/.test(text) && text.includes('git')) return 'git_missing'
  if (text.includes('not a git repository')) return 'not_a_repository'
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (text.includes('too many clients') || text.includes('connection terminated')) return 'db_unavailable'
  return 'unknown'
}

/**
 * Run an action body and return its value, or a failure envelope.
 *
 * Use this INSTEAD of letting an action throw when the message is meant for a
 * person. Redirects and Next's own control-flow errors are re-thrown
 * untouched — swallowing a `redirect()` would silently break navigation, and
 * it is thrown as an error by design.
 */
export async function guard<T>(work: () => Promise<T>): Promise<WithFailure<T>> {
  try {
    return await work()
  } catch (err) {
    if (isControlFlowError(err)) throw err
    const info = toFailureInfo(err)
    logger.error('action failed', { code: info.code, message: info.message, detail: info.detail })
    return failureEnvelope(info)
  }
}

/** Next signals redirect and notFound by throwing. Those are not failures and
 * must reach the framework. */
function isControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
}

/**
 * Client side: take the value, or throw an Error the browser created.
 *
 * This is the half that makes the whole thing adoptable. The throw happens in
 * the browser, so `error.message` is the real sentence, so every existing
 * `catch (err) { toast({ description: err.message }) }` starts telling the
 * truth without being edited. The failure's code and detail ride along for
 * callers that want to branch.
 */
export class ClientFailure extends Error {
  readonly code: FailureCode
  readonly detail?: string
  readonly retryable: boolean

  constructor(info: FailureInfo) {
    super(info.message)
    this.name = 'ClientFailure'
    this.code = info.code
    this.detail = info.detail
    this.retryable = info.retryable
  }
}

export function unwrap<T>(result: WithFailure<T>): T {
  if (isFailureEnvelope(result)) throw new ClientFailure(result.__failure)
  return result
}

/** For a caller that would rather branch than catch. */
export function failureOf<T>(result: WithFailure<T>): FailureInfo | null {
  return isFailureEnvelope(result) ? result.__failure : null
}

/**
 * A failure that genuinely must not propagate, said out loud in the code.
 *
 * There are 139 bare catches in this repo and most of them are correct — a
 * push notification must never fail the turn that triggered it. The problem
 * was that a deliberate swallow and an oversight looked identical. This makes
 * the deliberate ones self-describing and leaves nothing for an oversight to
 * hide behind.
 *
 *     await bestEffort(sendPush(...), 'a push must never fail the run')
 */
export async function bestEffort<T>(
  work: Promise<T> | (() => Promise<T>),
  why: string,
  fields?: Record<string, unknown>,
): Promise<T | undefined> {
  try {
    return await (typeof work === 'function' ? work() : work)
  } catch (err) {
    const info = toFailureInfo(err)
    logger.warn('best-effort step failed', { why, code: info.code, message: info.message, ...fields })
    return undefined
  }
}

/** Report a failure that should be seen but cannot be returned from here —
 * a background loop, an event handler, a subscription. */
export function reportFailure(err: unknown, context: string, fields?: Record<string, unknown>): FailureInfo {
  const info = toFailureInfo(err)
  logger.error(context, { code: info.code, message: info.message, detail: info.detail, ...fields })
  return info
}
