// Checks against the Hermes *install* itself — things this app depends on
// that live outside the repo and can silently change under it.
//
// The one check here guards a local patch to Hermes's own source. Root
// cause, reproduced in isolation on 2026-09-04: `tools/environments/local.py`
// probes Git Bash with `subprocess.run([...], capture_output=True)` and no
// `stdin=`, so the MSYS child inherits hermes-acp's stdin. Under this app
// that stdin is a synchronous pipe with a blocking `readline()` pending in
// the ACP library's stdin-feeder thread, and Windows serializes I/O on such
// a handle — the child deadlocks during its own startup, the 15s timeout
// kills only the launcher, and the inner bash keeps the stdout pipe open so
// `communicate()` never returns. Net effect: the FIRST terminal or file
// tool call of every run hung forever ("never completed"), then the run
// died on the inactivity watchdog. Adding `stdin=subprocess.DEVNULL` to the
// probe fixes it (verified: terminal call 0.6s, whole turn 8.6s).
//
// Because that patch lives in the Hermes checkout, a `hermes update` will
// quietly revert it and the hang will come back looking like a new bug.
// This check exists so that day is loud instead of mysterious.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface HermesInstallCheck {
  ok: boolean
  /** One sentence a person can act on. */
  detail: string
}

const PROBE_FUNCTION = 'def _bash_starts('
const PATCH_MARKER = 'stdin=subprocess.DEVNULL'

let cached: { mtimeMs: number; result: HermesInstallCheck } | null = null

function localPyPath(): string | null {
  const base = process.env.HERMES_HOME_BASE
  if (!base) return null
  return join(base, 'hermes-agent', 'tools', 'environments', 'local.py')
}

/**
 * True when Hermes's Git Bash probe is patched to not inherit stdin. Cheap
 * (one `stat`, and a read only when the file changed), so callers can run
 * it before every spawn without measurable cost.
 */
export async function checkHermesBashProbePatch(): Promise<HermesInstallCheck> {
  const path = localPyPath()
  if (!path) return { ok: true, detail: 'HERMES_HOME_BASE not set; install check skipped.' }
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    // No source checkout at that path (e.g. a packaged install) — nothing to
    // check, and nothing to warn about either.
    return { ok: true, detail: `No Hermes source at ${path}; install check skipped.` }
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.result

  let result: HermesInstallCheck
  try {
    const source = await readFile(path, 'utf-8')
    const start = source.indexOf(PROBE_FUNCTION)
    if (start === -1) {
      result = { ok: true, detail: 'Hermes no longer has a Git Bash probe; install check not applicable.' }
    } else {
      // Only the probe function body matters; a match elsewhere in the file
      // (there is one in the shell runner) must not count.
      const nextDef = source.indexOf('\ndef ', start + PROBE_FUNCTION.length)
      const body = source.slice(start, nextDef === -1 ? undefined : nextDef)
      result = body.includes(PATCH_MARKER)
        ? { ok: true, detail: 'Hermes Git Bash probe is patched to not inherit stdin.' }
        : {
            ok: false,
            detail:
              `Hermes's Git Bash probe (${path}, _bash_starts) inherits stdin again — a Hermes update reverted the local patch. ` +
              'The first terminal/file tool call of every run will hang until `stdin=subprocess.DEVNULL` is re-added there (see AGENTS.md, "Hermes terminal deadlock").',
          }
    }
  } catch (err) {
    result = { ok: true, detail: `Could not read ${path} (${String(err)}); install check skipped.` }
  }
  cached = { mtimeMs, result }
  return result
}

let warnedOnce = false

/** Logs the probe-patch warning once per process. For the dispatcher worker. */
export async function warnIfHermesProbeUnpatched(): Promise<void> {
  if (warnedOnce) return
  const check = await checkHermesBashProbePatch()
  if (check.ok) return
  warnedOnce = true
  console.warn(`[hermes] ${check.detail}`)
}
