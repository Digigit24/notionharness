// Legacy compatibility types for the existing Teable read surface. New
// database features use the native database types; this module is retained
// only while old connected blocks are migrated.
export interface TeableChoice { id?: string; name: string; color: string }
export interface TeableField { id: string; name: string; type: string; options?: { choices?: TeableChoice[]; relationship?: string; foreignTableId?: string } }
export interface TeableRecord { id: string; fields: Record<string, unknown> }
export interface ConnectionOption { id: number; name: string; teableTableId: string }
const HUE_CLASSES: Record<string, string> = { blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', cyan: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300', gray: 'bg-black/[.06] text-black/70 dark:bg-white/10 dark:text-white/70', green: 'bg-green-500/15 text-green-700 dark:text-green-300', orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300', pink: 'bg-pink-500/15 text-pink-700 dark:text-pink-300', purple: 'bg-purple-500/15 text-purple-700 dark:text-purple-300', red: 'bg-red-500/15 text-red-700 dark:text-red-300', teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-300', yellow: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300' }
export function colorClasses(token?: string): string { const hue = token?.replace(/(Light2|Light1|Bright|Dark1)$/, '') ?? 'gray'; return HUE_CLASSES[hue] ?? HUE_CLASSES.gray }
export function formatReadOnly(value: unknown): string { return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
