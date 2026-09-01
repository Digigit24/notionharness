'use client'

import { ReactNode } from 'react'
import { Bubble } from './Bubble'

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
export const defaultToolRenderer: ToolRenderer = (ctx) => {
  return (
    <div className="flex flex-col gap-2">
      <Bubble type="tool-call" metadata={{ toolName: ctx.toolName }}>
        <div className="whitespace-pre-wrap break-words">
          {JSON.stringify(ctx.toolInput, null, 2)}
        </div>
      </Bubble>
      {ctx.toolOutput !== undefined && (
        <Bubble type="tool-result" metadata={{ isError: ctx.isError }}>
          <div className="whitespace-pre-wrap break-words">
            {typeof ctx.toolOutput === 'string'
              ? ctx.toolOutput
              : JSON.stringify(ctx.toolOutput, null, 2)}
          </div>
        </Bubble>
      )}
    </div>
  )
}
