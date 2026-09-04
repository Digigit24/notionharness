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
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', resolved, ...args],
      viaShell: true,
    }
  }
  return { command: resolved, args, viaShell: false }
}
