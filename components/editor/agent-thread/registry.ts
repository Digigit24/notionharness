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

/**
 * ROADMAP B-3 "Surface" — same decoupling shape as the pair above, for a
 * second React/Lit boundary crossing: `PageDockedPanel` (a normal React
 * component mounted once per page, in `page-canvas.tsx`) registers itself
 * here on mount; `handleAskAgent` (registered via `registerAskAgentHandler`
 * above, invoked from BlockSuite's Lit toolbar — no React tree of its own)
 * calls `getPagePanelOpener()` to expand that same panel and hand it the
 * selected text as pre-attached context, instead of opening a separate
 * popover. Exactly one page (and therefore exactly one docked panel) is ever
 * mounted at a time, so — unlike `AskAgentHandler`, which carries its own
 * `doc`/`host` to resolve a page id — this opener needs no page id
 * parameter: whichever panel is currently mounted *is* the current page's.
 */
export type PagePanelOpener = (excerpt: string) => void

let panelOpener: PagePanelOpener | null = null

export function registerPagePanelOpener(fn: PagePanelOpener | null): void {
  panelOpener = fn
}

export function getPagePanelOpener(): PagePanelOpener | null {
  return panelOpener
}
