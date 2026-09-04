// R1.A.3 / R10.A.1 — the one place a probe code becomes a sentence.
//
// `runtime-profiles.lastProbeCode` stores a machine string on purpose (see
// `RuntimeProbeCode` in ./detect.ts): a code is greppable in a log and stable
// across releases in a way a sentence is not. What was missing is the other
// half. Every surface that had one of these codes printed it raw, so the
// screen said `acp_init_timeout` and left the reader to work out that a
// timeout and a missing binary are two entirely different problems with two
// entirely different fixes — which is the exact distinction ./detect.ts split
// the codes apart to preserve, thrown away at the last step.
//
// Each code implies precisely one fix, so each entry says it. This lives here
// rather than in the runtimes screen because the same code is shown in more
// than one place, and two screens explaining the same code differently is
// worse than neither explaining it.
//
// `import type` only: ./detect.ts spawns processes, and a client component
// that imported a VALUE from it would drag `node:child_process` into the
// browser bundle — the build break that file's own header documents. A type
// import is erased before that can happen.
import type { RuntimeProbeCode } from './detect'

export interface ProbeExplanation {
  /** Headline. What happened, in the fewest words that are still true. */
  title: string
  /** Why the probe ended that way — the state of the world, not the fix. */
  whatItMeans: string
  /** The single action that resolves it. One code, one fix; if this ever
   * needs an "or", the code is doing too much work and should be split. */
  whatToDo: string
}

const EXPLANATIONS: Record<RuntimeProbeCode, ProbeExplanation> = {
  ok: {
    title: 'Handshake complete',
    whatItMeans:
      'The command started and answered the ACP handshake, so a run dispatched to this profile has something real to talk to.',
    whatToDo: 'Nothing — this runtime is ready to use.',
  },
  command_not_found: {
    title: "The command isn't on this machine",
    whatItMeans:
      'Nothing by that name was found on PATH, so no process was ever started. This is an install problem, not a configuration one.',
    whatToDo:
      "Install the CLI on this machine, or edit this profile's command to the binary's full path if it is installed somewhere off PATH.",
  },
  spawn_failed: {
    title: "The command exists but wouldn't start",
    whatItMeans:
      'The file was found and the operating system still refused to run it — typically a permissions problem, or a wrapper script that is not executable.',
    whatToDo:
      'Run the same command yourself in a terminal on this machine; the error it prints there is the one to fix.',
  },
  acp_init_failed: {
    title: "It started, but it doesn't speak ACP",
    whatItMeans:
      'The process ran and then either rejected the ACP `initialize` call or exited before answering it. The binary is present; it is just not an ACP agent when started this way.',
    whatToDo:
      "Point this profile at the runtime's ACP entry point rather than its interactive CLI — most tools need a subcommand or flag (`… acp`, `--acp`) before they speak the protocol at all.",
  },
  acp_init_timeout: {
    title: 'It started but never answered',
    whatItMeans:
      'The process stayed alive and said nothing for the full 20 seconds. That is what an interactive CLI sitting at a prompt looks like from the outside, and what a runtime blocked on a login looks like too.',
    whatToDo:
      'Check that this command supports ACP mode, and that its credentials are already set up so it has nothing to ask for on startup — 20 seconds is well past a cold Node or Python start.',
  },
}

/**
 * The explanation for a stored code, or null when there is nothing honest to
 * say.
 *
 * Takes a `string` rather than a `RuntimeProbeCode` because that is what comes
 * back from the database: `lastProbeCode` is a plain text column, and a row
 * written by an older build can hold a code this version has never heard of.
 * Returning null there is deliberate — the caller then shows the raw code,
 * which is worse than a sentence but far better than a confident wrong one.
 */
export function explainProbeCode(code: string | null | undefined): ProbeExplanation | null {
  if (!code) return null
  return EXPLANATIONS[code as RuntimeProbeCode] ?? null
}

/** True when a string is one of our codes — used where a field may hold
 * either a probe code or free-form error text (see `checkAcpRuntime` in
 * `lib/runtimes/hermes/runtime-health.ts`, which falls back to the bare code
 * when it has no detail to report). */
export function isProbeCode(value: string | null | undefined): boolean {
  return !!value && value in EXPLANATIONS
}
