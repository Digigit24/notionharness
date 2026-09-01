// Shared types/helpers for every view controller (table/kanban/calendar) that
// renders a connected Teable table. Kept separate from any one view's
// rendering code so new views can reuse them without importing another
// view's module.

export interface TeableChoice {
  id?: string
  name: string
  color: string
}

export interface TeableField {
  id: string
  name: string
  type: string
  options?: { choices?: TeableChoice[]; relationship?: string; foreignTableId?: string }
}

export interface TeableRecord {
  id: string
  fields: Record<string, unknown>
}

export interface ConnectionOption {
  id: number
  name: string
  teableTableId: string
}

/** What a view controller (table/kanban/calendar) needs from the host block. */
export interface TeableViewHost {
  requestUpdate(): void
  openRecordDetail(recordId: string): void
}

/** Contract every per-tab view controller (table/kanban/calendar) implements. */
export interface TeableViewController {
  refresh(): Promise<void>
  render(): unknown
  dispose(): void
  /** Optional: close any of the controller's own open popovers (e.g. on outside click). */
  closePopovers?(): void
}

export const FIELD_TYPE_OPTIONS = [
  { value: 'singleLineText', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'singleSelect', label: 'Select' },
  { value: 'multipleSelect', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'user', label: 'Person' },
  { value: 'link', label: 'Relation' },
]

export const DEFAULT_CHOICE_COLORS = ['blue', 'green', 'red', 'orange', 'purple', 'teal', 'pink', 'yellow', 'cyan', 'gray']

// Teable color tokens are `<hue>[Light2|Light1|Bright|Dark1]` (e.g. `blueLight2`,
// `greenBright`) — strip the variant suffix and map the base hue to a fixed
// Tailwind pair that reads fine in both themes (opacity-based bg + a readable
// text shade per mode), rather than trying to reproduce every variant exactly.
const HUE_CLASSES: Record<string, string> = {
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  cyan: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  gray: 'bg-black/[.06] text-black/70 dark:bg-white/10 dark:text-white/70',
  green: 'bg-green-500/15 text-green-700 dark:text-green-300',
  orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  pink: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
  purple: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
  teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  yellow: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300',
}

export function colorClasses(token: string | undefined): string {
  if (!token) return HUE_CLASSES.gray
  const hue = token.replace(/(Light2|Light1|Bright|Dark1)$/, '')
  return HUE_CLASSES[hue] ?? HUE_CLASSES.gray
}

export function parseChoicesInput(raw: string): TeableChoice[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name, i) => ({ name, color: DEFAULT_CHOICE_COLORS[i % DEFAULT_CHOICE_COLORS.length] }))
}

export function formatReadOnly(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export const inputClass = 'w-full min-w-[100px] bg-transparent px-2 py-1 text-sm outline-none'
export const smallButtonClass = 'rounded px-1.5 py-0.5 text-[11px] hover:bg-black/[.06] dark:hover:bg-white/[.08]'
export const popoverClass =
  'absolute z-50 mt-1 rounded-lg border border-black/10 bg-white shadow-lg dark:border-white/10 dark:bg-[#2f2f2f]'
