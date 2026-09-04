'use client'

import { ReactNode } from 'react'
import { ToolCard } from './ToolCard'

/**
 * Tool renderer registry
 * Extension point for Tool UI (5.3) to register custom renderers per tool kind
 *
 * Default renderer shows the tool call input/output in JSON format.
 * Custom renderers can be registered to provide rich UI for specific tools.
 */

export interface ToolRendererContext {
  toolName: string
  toolInput: Record<string, unknown>
  toolOutput?: unknown
  isError?: boolean
  /** How long the call took, from `tool_call` to its `tool_result`. */
  durationMs?: number
  /** Paths the call touches, from ACP `ToolCall.locations`. */
  toolLocations?: string[]
  /** ACP tool kind (read/edit/search/execute/…). */
  toolKind?: string
  /** When the call started — used to detect a call that never returned. */
  startedAt?: string
  /** Coarse wall clock from the Thread's single shared timer. */
  now?: number
  /** The owning run reached a terminal status. */
  runEnded?: boolean
}

export type ToolRenderer = (ctx: ToolRendererContext) => ReactNode

const toolRenderers = new Map<string, ToolRenderer>()

/**
 * Register a custom renderer for a tool
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer) {
  toolRenderers.set(toolName, renderer)
}

/**
 * Get the renderer for a tool, or the default if not registered
 */
export function getToolRenderer(toolName: string): ToolRenderer {
  return toolRenderers.get(toolName) ?? defaultToolRenderer
}

/**
 * Default tool renderer — displays tool call and result as JSON
 */
export const defaultToolRenderer: ToolRenderer = (ctx) => (
  <ToolCard
    toolName={ctx.toolName}
    toolInput={ctx.toolInput}
    toolOutput={ctx.toolOutput}
    isError={ctx.isError}
    durationMs={ctx.durationMs}
    toolLocations={ctx.toolLocations}
    toolKind={ctx.toolKind}
    startedAt={ctx.startedAt}
    now={ctx.now}
    runEnded={ctx.runEnded}
  />
)
