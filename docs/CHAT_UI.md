# RunEvent-Native Chat UI (Roadmap P5.1)

Chat UI system built on RunEvent stream + shadcn primitives, without AI SDK.

## Architecture

### Three Layers

1. **RunEvent Adapter** (`lib/hermes/runEvent-adapter.ts`)
   - Converts `RunEventEnvelope` stream → `ChatThread`
   - Handles: message, thought, tool_call, tool_result, usage, done events
   - Two modes: batch (`adaptRunEventsToThread`) and streaming (`streamRunEventsToThread`)

2. **Chat Primitives** (`components/hermes/`)
   - `MessageScroller`: anchored scrolling, auto-scroll to latest
   - `Message`: role-based styling (user/assistant/system)
   - `Bubble`: content piece renderer (text, thinking, tool_call, tool_result)
   - `Attachment`: file/image attachment display
   - `Marker`: status indicators (loading, error, success, etc.)
   - `TypingIndicator`: three-dot animation

3. **Thread Component** (`components/hermes/Thread.tsx`)
   - Main UI component, renders `ChatThread`
   - Integrates MessageScroller + Bubble rendering
   - Shows usage metadata and done status
   - Extensible via tool renderer registry

### Extension Points

**Tool Renderers** (`components/hermes/tool-renderers.tsx`)
- Per-tool-kind custom UI renderer registry
- Default renderer shows tool input/output as JSON
- Tool UI team (5.3, in parallel) plugs in rich renderers here

## Usage

### Basic: Render a thread from envelopes

```tsx
import { adaptRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import { Thread } from '@/components/hermes'

// Get envelopes from broker/hermes-acp
const envelopes = await getRunEventsFromBroker(runId)

// Adapt to chat thread
const thread = adaptRunEventsToThread(envelopes)

// Render
<Thread thread={thread} showUsage showRunId />
```

### Streaming: Update as events arrive

```tsx
import { streamRunEventsToThread } from '@/lib/hermes/runEvent-adapter'
import { Thread } from '@/components/hermes'
import { useState, useEffect } from 'react'

export function LiveThread() {
  const [thread, setThread] = useState(null)

  useEffect(() => {
    async function streamEvents() {
      // Get event stream from broker
      const stream = openBrokerEventStream(runId)
      
      // Stream into thread state
      for await (const thread of streamRunEventsToThread(stream)) {
        setThread(thread)
      }
    }
    streamEvents()
  }, [])

  return thread && <Thread thread={thread} />
}
```

### Custom Tool Renderer

```tsx
import { registerToolRenderer } from '@/components/hermes/tool-renderers'

registerToolRenderer('my_tool', (ctx) => (
  <div className="custom-tool-renderer">
    <h3>{ctx.toolName}</h3>
    <pre>{JSON.stringify(ctx.toolInput, null, 2)}</pre>
    {ctx.toolOutput && <div>Result: {ctx.toolOutput}</div>}
  </div>
))
```

## Testing

Run the adapter test:
```bash
npm run test:runEvent-adapter
```

Visit demo page:
```bash
npm run dev
# Open http://localhost:3000/chat-ui-demo
```

## Integration Points

- **Gate 3/4 Wiring** (in parallel): broker run stream endpoint
- **Tool UI 5.3** (in parallel): registers tool renderers via registry
- **Chat UI Chromes 5.2** (next phase): wraps Thread in drawer/full-page/lane layouts

## Implementation Notes

### Why no AI SDK

RunEvent is structurally richer than AI SDK's token-shaped wire format:
- Tool calls carry full input object + status
- Separate thought/message events (AI SDK flattens to content parts)
- Usage per-event instead of at-run-end
- Permissions and file changes are first-class events

Flattening to text parts would destroy this richness before Tool UI (5.3) can consume it.

### MessageScroller anchor behavior

- Auto-scrolls to latest message when within 100px of bottom
- Preserves scroll position if user scrolls up (doesn't jump)
- Used by assistant-ui in production; battle-tested

### No hard dependency on @assistant-ui package

The adapter/components use assistant-ui *concepts* (ThreadRuntime shape, message structure) but don't import @assistant-ui itself. This:
- Keeps the dependency footprint small
- Avoids version coupling
- Lets tool renderers own their UI dependencies
- Ready for future assistant-ui integration if needed

### Content model

Each message holds an array of content pieces (text, thinking, tool_call, tool_result). This allows:
- Interleaved thoughts and text in assistant messages
- Multiple tool calls in sequence
- Matching tool results to their calls via ID
- Custom renderers to handle any content type
