/**
 * RunEvent → assistant-ui runtime adapter
 *
 * Converts the canonical RunEventEnvelope stream (Pillar 3.1) into
 * a shape suitable for assistant-ui's Thread component.
 * Handles message/thought/tool_call/tool_result/usage/done events.
 */

import type { RunEvent, RunEventEnvelope } from '@/lib/run-events'

/**
 * A Message in our chat runtime. Combines assistant-ui concepts with
 * RunEvent richness that AI SDK's token-shaped format would flatten.
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: Date
  content: ChatContent[]
}

export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; output: unknown; isError: boolean }

/**
 * Metadata about a usage event (tokens, cost, model)
 */
export interface UsageData {
  provider: string
  model: string
  tokens: number
  costTicks: number
}

/**
 * The complete chat thread state built from RunEvent stream
 */
export interface ChatThread {
  runId: string
  messages: ChatMessage[]
  usage: UsageData[]
  isRunning: boolean
  done?: { status: 'ok' | 'error' | 'cancelled'; reason?: string }
}

/**
 * Adapter: accumulate RunEventEnvelopes into a ChatThread
 */
export function adaptRunEventsToThread(envelopes: RunEventEnvelope[]): ChatThread {
  const thread: ChatThread = {
    runId: envelopes[0]?.runId ?? '',
    messages: [],
    usage: [],
    isRunning: true,
  }

  let assistantBuffer: ChatContent[] = []
  let lastToolCallId: string | null = null
  let currentAssistantMessageId: string | null = null

  for (const env of envelopes) {
    const event = env.event

    switch (event.type) {
      case 'message': {
        // If we have buffered assistant content, flush it first
        if (assistantBuffer.length > 0 && event.role === 'user') {
          if (currentAssistantMessageId) {
            const idx = thread.messages.findIndex((m) => m.id === currentAssistantMessageId)
            if (idx >= 0) {
              thread.messages[idx].content = assistantBuffer
            }
          }
          assistantBuffer = []
          currentAssistantMessageId = null
        }

        // Add the message
        const msg: ChatMessage = {
          id: `msg-${env.seq}`,
          role: event.role,
          createdAt: new Date(),
          content: [{ type: 'text', text: event.text }],
        }

        thread.messages.push(msg)

        if (event.role === 'assistant') {
          currentAssistantMessageId = msg.id
        }
        break
      }

      case 'thought': {
        if (!currentAssistantMessageId) {
          const msg: ChatMessage = {
            id: `msg-${env.seq}`,
            role: 'assistant',
            createdAt: new Date(),
            content: [],
          }
          thread.messages.push(msg)
          currentAssistantMessageId = msg.id
        }
        assistantBuffer.push({ type: 'thinking', text: event.text })
        break
      }

      case 'tool_call': {
        if (!currentAssistantMessageId) {
          const msg: ChatMessage = {
            id: `msg-${env.seq}`,
            role: 'assistant',
            createdAt: new Date(),
            content: [],
          }
          thread.messages.push(msg)
          currentAssistantMessageId = msg.id
        }
        assistantBuffer.push({
          type: 'tool_call',
          toolCallId: event.id,
          toolName: event.name,
          toolInput: event.input,
        })
        lastToolCallId = event.id
        break
      }

      case 'tool_result': {
        // Append to assistant buffer if there's a matching tool call
        if (lastToolCallId === event.id) {
          assistantBuffer.push({
            type: 'tool_result',
            toolCallId: event.id,
            output: event.output,
            isError: event.isError,
          })
        }
        break
      }

      case 'usage': {
        thread.usage.push({
          provider: event.provider,
          model: event.model,
          tokens: event.tokens,
          costTicks: event.costTicks,
        })
        break
      }

      case 'done': {
        thread.isRunning = false
        thread.done = {
          status: event.status,
          reason: event.reason,
        }
        break
      }

      // Permission and file_change are handled separately by UI layer
      case 'permission':
      case 'file_change':
      case 'terminal':
      case 'session':
        // These are not part of the message flow for now
        break
    }
  }

  // Flush remaining assistant buffer
  if (assistantBuffer.length > 0 && currentAssistantMessageId) {
    const idx = thread.messages.findIndex((m) => m.id === currentAssistantMessageId)
    if (idx >= 0) {
      thread.messages[idx].content = assistantBuffer
    }
  }

  return thread
}

/**
 * Stream adapter: build ChatThread incrementally from RunEvent stream
 * Yields updated ChatThread after each event
 */
export async function* streamRunEventsToThread(
  envelopeStream: AsyncIterable<RunEventEnvelope>,
): AsyncGenerator<ChatThread> {
  const thread: ChatThread = {
    runId: '',
    messages: [],
    usage: [],
    isRunning: true,
  }

  let assistantBuffer: ChatContent[] = []
  let lastToolCallId: string | null = null
  let currentAssistantMessageId: string | null = null

  for await (const env of envelopeStream) {
    if (!thread.runId) {
      thread.runId = env.runId
    }

    const event = env.event

    switch (event.type) {
      case 'message': {
        if (assistantBuffer.length > 0 && event.role === 'user') {
          if (currentAssistantMessageId) {
            const idx = thread.messages.findIndex((m) => m.id === currentAssistantMessageId)
            if (idx >= 0) {
              thread.messages[idx].content = assistantBuffer
            }
          }
          assistantBuffer = []
          currentAssistantMessageId = null
        }

        const msg: ChatMessage = {
          id: `msg-${env.seq}`,
          role: event.role,
          createdAt: new Date(),
          content: [{ type: 'text', text: event.text }],
        }

        thread.messages.push(msg)
        if (event.role === 'assistant') {
          currentAssistantMessageId = msg.id
        }
        break
      }

      case 'thought': {
        if (!currentAssistantMessageId) {
          const msg: ChatMessage = {
            id: `msg-${env.seq}`,
            role: 'assistant',
            createdAt: new Date(),
            content: [],
          }
          thread.messages.push(msg)
          currentAssistantMessageId = msg.id
        }
        assistantBuffer.push({ type: 'thinking', text: event.text })
        break
      }

      case 'tool_call': {
        if (!currentAssistantMessageId) {
          const msg: ChatMessage = {
            id: `msg-${env.seq}`,
            role: 'assistant',
            createdAt: new Date(),
            content: [],
          }
          thread.messages.push(msg)
          currentAssistantMessageId = msg.id
        }
        assistantBuffer.push({
          type: 'tool_call',
          toolCallId: event.id,
          toolName: event.name,
          toolInput: event.input,
        })
        lastToolCallId = event.id
        break
      }

      case 'tool_result': {
        if (lastToolCallId === event.id) {
          assistantBuffer.push({
            type: 'tool_result',
            toolCallId: event.id,
            output: event.output,
            isError: event.isError,
          })
        }
        break
      }

      case 'usage': {
        thread.usage.push({
          provider: event.provider,
          model: event.model,
          tokens: event.tokens,
          costTicks: event.costTicks,
        })
        break
      }

      case 'done': {
        thread.isRunning = false
        thread.done = {
          status: event.status,
          reason: event.reason,
        }
        break
      }

      case 'permission':
      case 'file_change':
      case 'terminal':
      case 'session':
        break
    }

    yield thread
  }
}
