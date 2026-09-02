import type { AskAgentHandler, AskAgentPageHandler } from './types'

/**
 * Decouples the toolbar trigger (this side, ROADMAP 6.2) from the popover +
 * run-creation implementation (the other side) so each can ship
 * independently instead of one importing the other's not-yet-built module.
 * The popover side calls `registerAskAgentHandler` once at module load;
 * the toolbar trigger calls `getAskAgentHandler` lazily, only when a user
 * actually clicks "Ask agent."
 */
let handler: AskAgentHandler | null = null

export function registerAskAgentHandler(fn: AskAgentHandler): void {
  handler = fn
}

export function getAskAgentHandler(): AskAgentHandler | null {
  return handler
}

/**
 * ROADMAP B3.5 — a second, distinct seam, same pattern as the pair above,
 * for a genuinely different context: `AskAgentHandler` always carries a
 * real selection (a floating popover anchored to it); this one is "open the
 * docked whole-page agent panel," fired by the new `/ask` slash item
 * (`components/editor/slash-commands/page-commands.ts`) with no selection
 * at all. That panel is being built on the parallel, not-yet-merged
 * `b3-docked-agent` branch — this repo can't import its not-yet-existing
 * module, so it registers itself here once it mounts, exactly like the
 * popover side does for `registerAskAgentHandler` above. Until that branch
 * merges, `getAskAgentPageHandler()` returns `null` and the slash item logs
 * a clear "not wired up yet" warning instead of silently no-op'ing.
 */
let pageHandler: AskAgentPageHandler | null = null

export function registerAskAgentPageHandler(fn: AskAgentPageHandler): void {
  pageHandler = fn
}

export function getAskAgentPageHandler(): AskAgentPageHandler | null {
  return pageHandler
}
