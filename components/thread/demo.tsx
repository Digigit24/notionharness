'use client'

import { useState, useEffect } from 'react'
import { Thread } from './Thread'
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import type { ChatThread } from '@/lib/hermes/runEvent-adapter'
import type { RunEventEnvelope } from '@/lib/run-events'

/**
 * Demo component for testing Thread with hermes-acp smoke test data
 * In production, this would consume the live RunEvent stream from the broker
 */
export function ThreadDemo() {
  const [thread, setThread] = useState<ChatThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadDemo() {
      try {
        setLoading(true)
        // In a real scenario, this would:
        // 1. Call the API to get the RunEventEnvelope stream
        // 2. Use streamRunEventsToThread to build the thread incrementally
        // 3. Update state for each yielded thread
        //
        // For now, we show the structure ready for integration

        // Simulated envelope stream (would come from broker/hermes-acp in production)
        const mockEnvelopes: RunEventEnvelope[] = [
          {
            runId: 'demo-run-1',
            seq: 1,
            event: { type: 'message', role: 'user', text: 'Hello, test the chat UI' },
          },
          {
            runId: 'demo-run-1',
            seq: 2,
            event: { type: 'message', role: 'assistant', text: 'I got your message. Let me think about this...' },
          },
          {
            runId: 'demo-run-1',
            seq: 3,
            event: { type: 'thought', text: 'The user wants me to test the chat UI. I should show various message types.' },
          },
          {
            runId: 'demo-run-1',
            seq: 4,
            event: {
              type: 'tool_call',
              id: 'tool-1',
              name: 'echo_tool',
              input: { message: 'Testing tool call rendering' },
              status: 'pending',
            },
          },
          {
            runId: 'demo-run-1',
            seq: 5,
            event: {
              type: 'tool_result',
              id: 'tool-1',
              output: { result: 'Echo received' },
              isError: false,
            },
          },
          {
            runId: 'demo-run-1',
            seq: 6,
            event: { type: 'usage', provider: 'anthropic', model: 'claude-opus', tokens: 150, costTicks: 75 },
          },
          {
            runId: 'demo-run-1',
            seq: 7,
            event: { type: 'done', status: 'ok' },
          },
        ]

        const adapted = adaptRunEventsToThread(mockEnvelopes)
        setThread(adapted)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadDemo()
  }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading demo thread...</div>
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen text-red-600">
        Error: {error}
      </div>
    )
  }

  if (!thread) {
    return <div className="flex items-center justify-center h-screen">No thread data</div>
  }

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-950">
      <div className="border-b border-gray-200 dark:border-gray-700 p-4">
        <h1 className="text-lg font-semibold">RunEvent Chat Thread Demo</h1>
      </div>
      <Thread thread={thread} showUsage={true} showRunId={true} />
    </div>
  )
}
