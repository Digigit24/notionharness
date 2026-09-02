/**
 * ROADMAP B8.4 (Batch B-6 "Finish") — structured logging.
 *
 * This repo has no `pino`/`winston`/similar dependency today, and this batch
 * can't run `npm install` to verify a new one actually resolves and behaves
 * as expected in this environment (per this batch's hard rules). Rather than
 * add an unverified dependency for a cross-cutting concern that would touch
 * every route/worker/script that logs anything, this is a small,
 * dependency-free structured-log helper — same "written and reviewable, not
 * blindly trusted" bar this session already holds new dependencies to
 * (`web-push`, `vitest`), just resolved the other direction here because a
 * ~40-line helper is easy to verify by reading it, and a wrong assumption
 * about a real logging library's API surface is not.
 *
 * Output is one JSON object per line on stdout/stderr (a standard, ingestible
 * shape for any log aggregator this app is later pointed at — Docker's own
 * `docker logs`, or a real log shipper) rather than pino's binary/pretty
 * duality, which would need the dependency this file is deliberately not
 * adding. `instrumentation.ts`'s existing `unhandledRejection` logger is
 * extended to use this (see that file) rather than replaced.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

interface LogRecord {
  level: LogLevel
  time: string
  msg: string
  [key: string]: unknown
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const record: LogRecord = { level, time: new Date().toISOString(), msg, ...fields }
  // Errors go to stderr so they're distinguishable in `docker logs`/shell
  // redirection from normal operational noise; everything else to stdout.
  const line = JSON.stringify(record)
  if (level === 'error' || level === 'warn') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  /**
   * `error` may be an `Error`, a caught `unknown`, or omitted entirely — the
   * common shapes this codebase's own `catch` blocks already produce
   * (several already normalize with `err instanceof Error ? err.message :
   * 'fallback'`; this centralizes that instead of repeating it per call
   * site going forward).
   */
  error: (msg: string, error?: unknown, fields?: LogFields) =>
    write('error', msg, {
      ...fields,
      ...(error !== undefined
        ? {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        : {}),
    }),
}
