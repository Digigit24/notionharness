/**
 * The approval modes Hermes accepts, with the wording a person needs at the
 * moment of choosing.
 *
 * A plain module rather than a constant in the server-actions file: a
 * `"use server"` file may only export async functions, so exporting this
 * array from there failed the production build outright ("A 'use server' file
 * can only export async functions, found object"). Both the client component
 * and the server action import it from here.
 *
 * Values match `tools/approval.py`'s own validation; the descriptions match
 * what each mode actually does, not what it is called.
 */
export const APPROVAL_MODES = [
  { value: 'manual', label: 'Ask every time', hint: 'Every risky command waits for you.' },
  { value: 'smart', label: 'Smart', hint: 'Hermes judges; unfamiliar or destructive actions still ask.' },
  { value: 'off', label: 'Never ask', hint: 'Nothing pauses. Only for a sandbox you can afford to lose.' },
] as const

export type ApprovalMode = (typeof APPROVAL_MODES)[number]['value']
