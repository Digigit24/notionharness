'use client'

import type { ComponentType, ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileCode2, FileSearch, Terminal } from 'lucide-react'
import { useState } from 'react'
import type { RunEvent } from '@/lib/run-events'
import { Button } from '@/components/ui/button'

export type ToolPair = {
  call: Extract<RunEvent, { type: 'tool_call' }>
  result?: Extract<RunEvent, { type: 'tool_result' }>
}

export type ToolComponentProps = { pair: ToolPair }

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  try { return JSON.stringify(output, null, 2) ?? String(output) } catch { return String(output) }
}

function exitLabel(result: ToolPair['result']): string | undefined {
  if (!result || typeof result.output !== 'object' || result.output === null) return undefined
  const output = result.output as Record<string, unknown>
  const exitCode = output.exitCode ?? output.exit_code
  return typeof exitCode === 'number' ? `Exit ${exitCode}` : undefined
}

function toolLabel(name: string) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function BashTool({ pair }: ToolComponentProps) {
  const command = typeof pair.call.input.command === 'string' ? pair.call.input.command : outputText(pair.call.input)
  const output = pair.result ? outputText(pair.result.output) : 'Running…'
  return <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm">
    <header className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2 text-sm"><Terminal className="size-4" /><span className="font-medium">Terminal</span>{pair.result?.isError ? <span className="ml-auto text-xs text-destructive">{exitLabel(pair.result) ?? 'Failed'}</span> : pair.result ? <span className="ml-auto text-xs text-muted-foreground">{exitLabel(pair.result) ?? 'Completed'}</span> : <span className="ml-auto text-xs text-muted-foreground">Running</span>}</header>
    <pre className="overflow-x-auto px-3 py-3 font-mono text-xs"><code><span className="text-muted-foreground">$ </span>{command}{'\n'}{output}</code></pre>
  </article>
}

export function DiffTool({ pair }: ToolComponentProps) {
  const path = typeof pair.call.input.path === 'string' ? pair.call.input.path : 'Changed file'
  const diff = typeof pair.call.input.diff === 'string' ? pair.call.input.diff : outputText(pair.result?.output ?? pair.call.input)
  return <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm"><header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm"><FileCode2 className="size-4" /><span className="font-medium">{toolLabel(pair.call.name)}</span><code className="ml-auto truncate text-xs text-muted-foreground">{path}</code></header><pre className="max-h-72 overflow-auto bg-muted/30 px-3 py-3 font-mono text-xs leading-5"><code>{diff.split('\n').map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'block text-emerald-600 dark:text-emerald-400' : line.startsWith('-') ? 'block text-red-600 dark:text-red-400' : 'block'}>{line}</span>)}</code></pre></article>
}

export function ReadGrepTool({ pair }: ToolComponentProps) {
  const [open, setOpen] = useState(false)
  const output = pair.result ? outputText(pair.result.output) : ''
  const files = output.split(/\r?\n/).filter(Boolean)
  return <article className="rounded-lg border border-border bg-card text-card-foreground shadow-sm"><Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-2 px-3" onClick={() => setOpen((value) => !value)}><FileSearch className="size-4" /> <span className="font-medium">{toolLabel(pair.call.name)}</span><span className="text-muted-foreground">{files.length || 'Several'} {files.length === 1 ? 'file' : 'files'}</span>{open ? <ChevronDown className="ml-auto size-4" /> : <ChevronRight className="ml-auto size-4" />}</Button>{open && <pre className="max-h-48 overflow-auto border-t border-border px-3 py-2 font-mono text-xs"><code>{output || 'No output'}</code></pre>}</article>
}

export function JsonTool({ pair }: ToolComponentProps) {
  return <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm"><header className="border-b border-border px-3 py-2 text-sm font-medium">{toolLabel(pair.call.name)}</header><pre className="max-h-72 overflow-auto px-3 py-3 font-mono text-xs"><code>{outputText(pair.result?.output ?? { input: pair.call.input, status: pair.call.status })}</code></pre></article>
}

export const toolComponentRegistry: Record<string, ComponentType<ToolComponentProps>> = {
  bash: BashTool,
  shell: BashTool,
  execute: BashTool,
  edit: DiffTool,
  write: DiffTool,
  read: ReadGrepTool,
  grep: ReadGrepTool,
}

/** Resolve exact names first, then common tool-name prefixes, with safe JSON fallback. */
export function resolveToolComponent(name: string): ComponentType<ToolComponentProps> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (toolComponentRegistry[name.toLowerCase()]) return toolComponentRegistry[name.toLowerCase()]
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('terminal')) return BashTool
  if (normalized.includes('edit') || normalized.includes('write')) return DiffTool
  if (normalized.includes('read') || normalized.includes('grep') || normalized.includes('search')) return ReadGrepTool
  return JsonTool
}

export function ToolEventCard({ pair }: ToolComponentProps) {
  const Component = resolveToolComponent(pair.call.name)
  return <Component pair={pair} />
}

export function DemoToolPair({ pair, label }: { pair: ToolPair; label: string }): ReactNode {
  return <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p><ToolEventCard pair={pair} /></div>
}
