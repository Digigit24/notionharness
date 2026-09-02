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
 * here on mount. Two independent callers open it through this one seam:
 * `handleAskAgent` (`block-anchored-thread.tsx`, the selection-anchored
 * toolbar trigger) hands over the selected text as pre-attached context; the
 * `/ask` slash item (`components/editor/slash-commands/page-commands.ts`,
 * no selection, a bare cursor position) calls it with an empty excerpt,
 * which the panel already treats the same as "no context" (falsy, same as
 * `null`) — whole-page context by default. Exactly one page (and therefore
 * exactly one docked panel) is ever mounted at a time, so this opener needs
 * no page id parameter: whichever panel is currently mounted *is* the
 * current page's.
 *
 * (An earlier, parallel draft of this seam — `AskAgentPageHandler`, carrying
 * a full `{doc, host, pageId, anchorElement}` context — was built
 * independently on the `b3-blocks-slashmenu` branch before this one merged,
 * for the same purpose. Consolidated onto this simpler, already-connected
 * excerpt-based opener during the merge rather than keeping two seams for
 * one concept; see `page-commands.ts`'s `/ask` item for the caller-side fix.)
 */
export type PagePanelOpener = (excerpt: string) => void

let panelOpener: PagePanelOpener | null = null

export function registerPagePanelOpener(fn: PagePanelOpener | null): void {
  panelOpener = fn
}

export function getPagePanelOpener(): PagePanelOpener | null {
  return panelOpener
}
