'use client'

import { ReactNode } from 'react'
import { MessageScroller } from './MessageScroller'
import { Message } from './Message'
import { Bubble } from './Bubble'
import { getToolRenderer } from './tool-renderers'
import type { ChatThread, ChatContent } from '@/lib/hermes/runEvent-adapter'

/**
 * Thread component
 *
 * Main UI component for rendering a ChatThread built from RunEvent stream.
 * Handles streaming updates via React re-renders.
 *
 * Usage:
 *   const thread = adaptRunEventsToThread(envelopes)
 *   <Thread thread={thread} />
 *
 * For streaming:
 *   for await (const thread of streamRunEventsToThread(stream)) {
 *     setThread(thread)
 *   }
 *   <Thread thread={thread} />
 */
export interface ThreadProps {
  thread: ChatThread
  autoScroll?: boolean
  showUsage?: boolean
  showRunId?: boolean
}

export function Thread({ thread, autoScroll = true, showUsage = true, showRunId = false }: ThreadProps) {
  return (
    <div className="flex flex-col h-full">
      <MessageScroller autoScroll={autoScroll} className="flex-1">
        {thread.messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">No messages yet</div>
        ) : (
          thread.messages.map((message) => (
            <Message key={message.id} role={message.role}>
              <div className="flex flex-col gap-2">
                {message.content.map((content, idx) => renderContent(content, idx))}
              </div>
            </Message>
          ))
        )}
      </MessageScroller>

      {/* Run metadata footer */}
      <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-xs text-gray-600 dark:text-gray-400">
        {showRunId && thread.runId && <div>Run: {thread.runId}</div>}

        {showUsage && thread.usage.length > 0 && (
          <div className="mt-1">
            {thread.usage.map((u, idx) => (
              <div key={idx}>
                {u.provider}/{u.model}: {u.tokens} tokens ({u.costTicks} ticks)
              </div>
            ))}
          </div>
        )}

        {thread.done && (
          <div className={`mt-1 font-semibold ${thread.done.status === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {thread.done.status.toUpperCase()}
            {thread.done.reason && `: ${thread.done.reason}`}
          </div>
        )}

        {thread.isRunning && <div>Running...</div>}
      </div>
    </div>
  )
}

/**
 * Render individual content pieces within a message
 */
function renderContent(content: ChatContent, key: number): ReactNode {
  switch (content.type) {
    case 'text':
      return <Bubble key={key} type="text">{content.text}</Bubble>

    case 'thinking':
      return <Bubble key={key} type="thinking">{content.text}</Bubble>

    case 'tool_call': {
      const renderer = getToolRenderer(content.toolName)
      return (
        <div key={key}>
          {renderer({
            toolName: content.toolName,
            toolInput: content.toolInput,
          })}
        </div>
      )
    }

    case 'tool_result': {
      // Rendered as part of tool_call in the default renderer
      return null
    }

    default:
      return null
  }
}
