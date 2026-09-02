import type { AskAgentHandler } from './types'

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
