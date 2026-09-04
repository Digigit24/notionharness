// R12-P1.4 — the taxonomy is only worth writing down if it is checked.
//
// The strings below are the real ones: `promisify(execFile)`'s "Command
// failed: git --git-dir … worktree add …", node-postgres's "timeout exceeded
// when trying to acquire a connection from the pool", Hermes's "API call
// failed after 3 retries: HTTP 429: …", ACP's bare `cancelled` stop reason.
// A table of invented sentences would pass while the dispatcher went on
// misclassifying everything it actually sees.

import { describe, expect, it } from 'vitest'
import { classifyRunFailure, runDisposition } from '@/lib/dispatcher/classify-failure'
import { failure } from '@/lib/failures'

describe('classifyRunFailure', () => {
  it('treats an exhausted or dropped connection as retryable', () => {
    for (const text of [
      'timeout exceeded when trying to acquire a connection from the pool',
      'sorry, too many clients already',
      'Connection terminated unexpectedly',
      'read ECONNRESET',
    ]) {
      expect(classifyRunFailure(new Error(text)), text).toEqual({
        outcome: 'failed',
        code: 'db_unavailable',
        retryable: true,
      })
    }
  })

  // The bug this file exists to prevent: a pool blip reaching the agent lookup
  // was reported as "Agent missing or disabled" and settled non-retryable.
  it('does not read a database failure as a missing agent', () => {
    const disposition = classifyRunFailure(new Error('Could not load agent 6: sorry, too many clients already'))
    expect(disposition).toEqual({ outcome: 'failed', code: 'db_unavailable', retryable: true })
  })

  it('requeues a lost lease', () => {
    expect(classifyRunFailure(new Error('lease expired for run 214'))).toEqual({
      outcome: 'failed',
      code: 'conflict',
      retryable: true,
    })
  })

  it('retries a failed worktree creation once and then stops', () => {
    const text = 'Command failed: git --git-dir C:/x.git worktree add -b run/1 C:/y HEAD\nfatal: could not create'
    expect(classifyRunFailure(new Error(text), { attempt: 1 })).toEqual({
      outcome: 'failed',
      code: 'worktree_missing',
      retryable: true,
    })
    expect(classifyRunFailure(new Error(text), { attempt: 2 })).toEqual({
      outcome: 'failed',
      code: 'worktree_missing',
      retryable: false,
    })
  })

  it('does not requeue a missing agent or a missing binary', () => {
    expect(classifyRunFailure('Agent missing or disabled.')).toEqual({
      outcome: 'failed',
      code: 'agent_unavailable',
      retryable: false,
    })
    expect(classifyRunFailure(new Error('spawn hermes ENOENT'))).toEqual({
      outcome: 'failed',
      code: 'runtime_not_installed',
      retryable: false,
    })
  })

  // Both are ENOENT. Only one of them is the agent binary.
  it("reads git's own ENOENT as git rather than as the agent binary", () => {
    expect(classifyRunFailure(new Error('spawn git ENOENT'))).toMatchObject({ code: 'git_missing' })
  })

  it('retries a handshake timeout but not an unanswered approval', () => {
    expect(classifyRunFailure(new Error('timed out waiting for initialize response'))).toEqual({
      outcome: 'failed',
      code: 'runtime_handshake_failed',
      retryable: true,
    })
    expect(classifyRunFailure(new Error('The approval timed out after 5 minutes'))).toEqual({
      outcome: 'failed',
      code: 'timeout',
      retryable: false,
    })
    expect(classifyRunFailure(new Error('Turn exceeded its wall-clock limit and timed out'))).toEqual({
      outcome: 'failed',
      code: 'timeout',
      retryable: true,
    })
  })

  it('does not requeue a provider cap or a model that stopped on its own', () => {
    expect(classifyRunFailure('API call failed after 3 retries: HTTP 429: The usage limit has been reached')).toMatchObject({
      code: 'spend_cap_reached',
      retryable: false,
    })
    expect(classifyRunFailure('refusal')).toMatchObject({ code: 'run_not_retryable', retryable: false })
    expect(classifyRunFailure('max_tokens')).toMatchObject({ code: 'run_not_retryable', retryable: false })
  })

  it('is not a failure at all when the run was cancelled', () => {
    expect(classifyRunFailure('cancelled')).toEqual({ outcome: 'cancelled' })
    // A killed process reports whatever the transport said as it closed, so
    // the stop flag has to beat the text.
    expect(classifyRunFailure(new Error('read ECONNRESET'), { cancellationRequested: true })).toEqual({
      outcome: 'cancelled',
    })
  })

  it('keeps a deliberately raised code rather than guessing at its sentence', () => {
    expect(classifyRunFailure(failure('spend_cap_reached', 'This workspace is over its cap.'))).toEqual({
      outcome: 'failed',
      code: 'spend_cap_reached',
      retryable: false,
    })
  })

  it('retries what it does not recognise', () => {
    expect(classifyRunFailure(new Error('the sky fell in'))).toEqual({
      outcome: 'failed',
      code: 'unknown',
      retryable: true,
    })
  })
})

describe('runDisposition', () => {
  it('answers the same way the patterns do for a cause named outright', () => {
    expect(runDisposition('agent_unavailable')).toEqual({
      outcome: 'failed',
      code: 'agent_unavailable',
      retryable: false,
    })
    expect(runDisposition('invalid_input')).toEqual({ outcome: 'failed', code: 'invalid_input', retryable: false })
    expect(runDisposition('worktree_missing', { attempt: 3 })).toMatchObject({ retryable: false })
  })
})
