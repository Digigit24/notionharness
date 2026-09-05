// Turning a configured runtime command into something `spawn` can actually run.
//
// This exists because the probe and the run path disagreed, in the worst
// possible direction: `detect.ts` resolved a command properly and reported
// `ok`, while `acp-client.ts` spawned the raw configured string. On Windows,
// where npm installs every CLI as a `.cmd` shim, that meant a runtime could
// probe green and then fail at ENOENT the first time someone actually used it
// — a green light that predicted nothing.
//
// So the resolution lives here, once, and both callers use it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface ResolvedCommand {
  /** What to hand `spawn` as the executable. */
  command: string
  /** Arguments, including any that were inline in the configured string and
   * any COMSPEC prelude needed to run a batch shim. */
  args: string[]
  /** True when this is being run through the Windows command processor. */
  viaShell: boolean
  /**
   * Pass through to `spawn` as `windowsVerbatimArguments`. True exactly when
   * `viaShell` is: the command line handed to `cmd.exe` is already quoted
   * the way `/s /c` expects (see `batchShimInvocation`), and Node's own
   * quoting on top of that is what broke `npx` under `C:\Program Files`.
   */
  windowsVerbatimArguments: boolean
}

/**
 * Quotes one argument for `cmd.exe`. Only when it needs it: a bare word
 * passes through untouched, which keeps the common case identical to what
 * ran before.
 */
function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * How to run a `.cmd`/`.bat` shim, correctly, whatever directory it lives in.
 *
 * The previous form — `cmd /d /s /c <shim> <args>` with Node quoting each
 * argument — worked for every shim under `%APPDATA%\npm` and failed for
 * `npx.cmd` under `C:\Program Files\nodejs`: Node quoted the path, `/s`
 * stripped the first and last quote of the WHOLE command line, and cmd was
 * left running `C:\Program` — verified live as "'C:\Program' is not
 * recognized as an internal or external command". `/s` exists for exactly
 * one form: the entire command line wrapped in one outer pair of quotes,
 * each inner token quoted on its own, and nothing re-quoted by the caller —
 * hence `windowsVerbatimArguments`.
 */
export function batchShimInvocation(shimPath: string, args: string[]): ResolvedCommand {
  const line = [shimPath, ...args].map(quoteForCmd).join(' ')
  return {
    command: process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    viaShell: true,
    windowsVerbatimArguments: true,
  }
}

/**
 * Splits a configured command that carries its own arguments.
 *
 * `claude --dangerously-skip-permissions` is one string in the database and
 * two things to `spawn`. Checked against the filesystem first, because a path
 * containing a space (`C:\Program Files\...`) is a single command, not a
 * command plus an argument.
 */
export function splitCommand(commandName: string, extraArgs: string[] = []): { command: string; args: string[] } {
  const trimmed = commandName.trim()
  if (!trimmed.includes(' ') || existsSync(trimmed)) return { command: trimmed, args: extraArgs }
  const [command, ...inline] = trimmed.split(/\s+/)
  return { command, args: [...inline, ...extraArgs] }
}

/**
 * Finds the real executable for a bare command name.
 *
 * `spawn` does not consult PATHEXT, so `claude` does not find `claude.cmd`.
 * Worse, npm installs three shims side by side and `where` lists the
 * extensionless shell script first — which Node cannot execute at all. Hence
 * the ranking: a real executable image beats a batch shim beats anything else.
 */
export async function resolveCommandPath(command: string): Promise<string | null> {
  if (existsSync(command)) return command
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    const child = spawn(finder, [command], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const candidates = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && existsSync(line))
      if (candidates.length === 0) return resolve(null)
      const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2)
      candidates.sort((a, b) => rank(a) - rank(b))
      resolve(candidates[0])
    })
  })
}

/**
 * Everything needed to spawn a configured runtime command.
 *
 * Returns the original command unresolved when nothing is found on PATH, so
 * the caller still gets a real ENOENT naming what was actually configured
 * rather than a null-shaped failure that says nothing.
 */
export async function resolveSpawnCommand(commandName: string, extraArgs: string[] = []): Promise<ResolvedCommand> {
  const { command, args } = splitCommand(commandName, extraArgs)
  const resolved = (await resolveCommandPath(command)) ?? command

  // A `.cmd`/`.bat` is a script for the command processor, not an executable
  // image, so `spawn` cannot run it directly — it fails with EINVAL or ENOENT.
  if (/\.(cmd|bat)$/i.test(resolved)) return batchShimInvocation(resolved, args)
  return { command: resolved, args, viaShell: false, windowsVerbatimArguments: false }
}
