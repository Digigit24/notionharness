// Registers every home strategy the app ships, exactly once.
//
// `lib/runtimes/home.ts` kept a registry and `lib/runtimes/hermes/home-
// strategy.ts` registered into it — and nothing imported that file, so the
// registry was empty at runtime and `run-with-identity.ts` branched on the
// string 'hermes' instead. This module is the missing import: the run path
// pulls it in for its side effects, and from then on a strategy id from a
// runtime profile resolves to real code.
//
// Server-side only: it reaches `node:fs` through both strategies it
// registers. Not marked with the `server-only` package because the
// dispatcher and its verification scripts run under `tsx`, where that
// package does not exist (see `scripts/server-only-shim.ts`).
import { RUNTIME_CATALOG } from './catalog'
import { registerRuntimeHomeStrategy } from './home'
import { createLinkedHomeStrategy } from './linked-home'
import './hermes/home-strategy'

for (const entry of RUNTIME_CATALOG) {
  if (entry.home) registerRuntimeHomeStrategy(createLinkedHomeStrategy(entry))
}
