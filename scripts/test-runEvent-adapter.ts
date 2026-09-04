/**
 * Test script for RunEvent adapter
 *
 * Demonstrates the RunEvent → ChatThread conversion working end-to-end.
 * This can be run standalone to verify the adapter logic before integrating
 * with the actual hermes-acp smoke test data.
 *
 * Usage:
 *   npx tsx scripts/test-runEvent-adapter.ts
 */

import { adaptRunEventsToThread } from '../lib/hermes/runEvent-adapter'
import type { RunEventEnvelope } from '../lib/run-events'

// Mock RunEvent stream for testing
const mockEnvelopes: RunEventEnvelope[] = [
  {
    runId: 'test-run-001',
    seq: 1,
    event: {
      type: 'message',
      role: 'user',
      text: 'What can you do for me?',
    },
  },
  {
    runId: 'test-run-001',
    seq: 2,
    event: {
      type: 'message',
      role: 'assistant',
      text: 'I can help with various tasks. Let me think about what you need...',
    },
  },
  {
    runId: 'test-run-001',
    seq: 3,
    event: {
      type: 'thought',
      text: 'The user is asking for my capabilities. I should provide a comprehensive overview.',
    },
  },
  {
    runId: 'test-run-001',
    seq: 4,
    event: {
      type: 'tool_call',
      id: 'call-1',
      name: 'list_capabilities',
      input: { include_experimental: false },
      status: 'pending',
    },
  },
  {
    runId: 'test-run-001',
    seq: 5,
    event: {
      type: 'tool_result',
      id: 'call-1',
      output: {
        capabilities: ['analysis', 'writing', 'coding', 'math', 'reasoning'],
      },
      isError: false,
    },
  },
  {
    runId: 'test-run-001',
    seq: 6,
    event: {
      type: 'message',
      role: 'assistant',
      text: 'I can help with analysis, writing, coding, math, and reasoning tasks.',
    },
  },
  {
    runId: 'test-run-001',
    seq: 7,
    event: {
      type: 'usage',
      provider: 'anthropic',
      model: 'claude-opus',
      tokens: 287,
      costTicks: 143,
    },
  },
  {
    runId: 'test-run-001',
    seq: 8,
    event: {
      type: 'done',
      status: 'ok',
    },
  },
]

function main() {
  console.log('Testing RunEvent adapter...\n')

  try {
    const thread = adaptRunEventsToThread(mockEnvelopes)

    console.log(`✓ Converted ${mockEnvelopes.length} envelopes to ChatThread`)
    console.log(`  Run ID: ${thread.runId}`)
    console.log(`  Messages: ${thread.messages.length}`)
    console.log(`  Usage events: ${thread.usage.length}`)
    console.log(`  Status: ${thread.done?.status ?? 'running'}`)
    console.log()

    console.log('Message summary:')
    for (const msg of thread.messages) {
      console.log(`  [${msg.role.toUpperCase()}] (${msg.id}): ${msg.content.length} content pieces`)
      for (const content of msg.content) {
        let summary = ''
        switch (content.type) {
          case 'text':
            summary = content.text.slice(0, 60)
            break
          case 'thinking':
            summary = `💭 ${content.text.slice(0, 50)}`
            break
          case 'tool_call':
            summary = `🔧 ${content.toolName}(${JSON.stringify(content.toolInput).slice(0, 40)})`
            if (content.toolOutput !== undefined) summary += ` → ${JSON.stringify(content.toolOutput).slice(0, 40)}`
            break
          case 'terminal':
            summary = `$ ${content.text.slice(0, 60)}`
            break
        }
        if (summary) {
          console.log(`    - ${content.type}: ${summary}`)
        }
      }
    }

    console.log()
    console.log('Usage details:')
    for (const usage of thread.usage) {
      console.log(`  ${usage.provider}/${usage.model}: ${usage.tokens} tokens (${usage.costTicks} ticks)`)
    }

    console.log()
    console.log('✅ Adapter test passed!')
  } catch (err) {
    console.error('❌ Adapter test failed:', err)
    process.exitCode = 1
  }
}

main()
