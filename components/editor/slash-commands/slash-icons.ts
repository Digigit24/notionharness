// Icons for this app's OWN slash-menu items (native-database, task,
// page-commands) — BlockSuite's stock items all carry an `icon:
// TemplateResult` (see `@blocksuite/blocks`' own `slash-menu/config.ts`),
// and ours never did, which is why "Database", "Task", "Ask agent" etc. sat
// in the menu with a blank square where every stock item has a glyph.
//
// Hand-built from lucide's raw path data (the same icon set every React
// surface in this app already uses, via `lucide-react`) rather than adding
// `@blocksuite/icons` as a live import: that package is listed in
// package.json but is not actually present in node_modules (confirmed by
// grep — nothing in this codebase imports from it today), so depending on
// it now would be reaching for a dependency that isn't actually installed
// rather than one this app already has proven working. Lifting the exact
// `d` attributes from `node_modules/lucide-react/dist/esm/icons/*.mjs`
// keeps the visual language identical without adding a new package.
import { svg, type TemplateResult } from 'lit'

const wrap = (body: TemplateResult) => svg`
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${body}
  </svg>
`

export const databaseIcon = wrap(svg`
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M3 5V19A9 3 0 0 0 21 19V5" />
  <path d="M3 12A9 3 0 0 0 21 12" />
`)

export const tableIcon = wrap(svg`
  <path d="M12 3v18" />
  <rect width="18" height="18" x="3" y="3" rx="2" />
  <path d="M3 9h18" />
  <path d="M3 15h18" />
`)

export const taskIcon = wrap(svg`
  <path d="M13 5h8" />
  <path d="M13 12h8" />
  <path d="M13 19h8" />
  <path d="m3 17 2 2 4-4" />
  <rect x="3" y="4" width="6" height="6" rx="1" />
`)

export const askAgentIcon = wrap(svg`
  <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
`)

export const runAgentIcon = wrap(svg`
  <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
`)

export const summariseIcon = wrap(svg`
  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 9H8" />
  <path d="M16 13H8" />
  <path d="M16 17H8" />
`)

export const mentionAgentIcon = wrap(svg`
  <circle cx="12" cy="12" r="4" />
  <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
`)
