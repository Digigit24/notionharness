# P5.2: One Thread, Three Chromes

Mounts the same `<Thread/>` component from P5.1 in three different layout contexts, preventing "sidebar chat" and "full chat" from diverging into separate code.

## The Three Chromes

### 1. ThreadDrawerTab (Task Drawer)

**Location:** Task drawer's "Sessions" tab  
**Component:** `ThreadDrawerTab`  
**Layout:** Vertical stack, most recent run prominent, older runs collapsible

Shows all runs for a task in the drawer sidebar. Latest run displayed full-height with others collapsed underneath.

```tsx
<ThreadDrawerTab
  taskId={task.id}
  agents={agents}
  loader={async (id) => {
    const runs = await getTaskRuns(id)
    return Promise.all(runs.map(async (run) => ({ run, events: await getRunMessages(run.id) })))
  }}
/>
```

### 2. ThreadFullPage (Full-Page View)

**Location:** `/thread-full-page` (demo route, integrate as workspace route)  
**Component:** `ThreadFullPage`  
**Layout:** Split screen — session list rail (left) + thread view (right)

Dedicated full-page view with a sidebar listing all runs. Click a run to view its thread in the main area. Useful for detailed examination of runs.

```tsx
<ThreadFullPage
  taskId={task.id}
  taskTitle={task.title}
  agents={agents}
  loader={loader}
/>
```

### 3. ThreadLaneView (Multi-Agent/Team Lane)

**Location:** `/thread-lane-demo` (demo route, integrate into team/multi-agent board)  
**Component:** `ThreadLaneView`  
**Layout:** Constrained height card, part of a grid/row of lanes

Renders the most recent run's thread in a compact card suitable for side-by-side display in a team view. Shows all lanes at once (one card per task) for monitoring multiple parallel runs.

```tsx
<ThreadLaneView
  taskId={task.id}
  taskTitle={task.title}
  agents={agents}
  loader={loader}
  height="h-[600px]"
/>
```

## Data Flow

All three use the same data pipeline:

1. **Hook:** `useThreadData(taskId, observed, loader)`
   - Wraps `useRunEventStream` (P5.7) for polling + batching
   - Converts `RunMessageRow[]` → `RunEventEnvelope[]`
   - Adapts via `adaptRunEventsToThread()` from P5.1

2. **Data Source:** `getTaskRuns()` + `getRunMessages()`
   - Server actions from tasks actions file
   - Already live and used by Sessions tab

3. **Component:** Same `<Thread/>` from P5.1
   - No code duplication across chromes
   - All three receive identical `ChatThread` data

## Integration Points

### Replace Sessions Tab (Done)
Task drawer's SessionsTab now uses `ThreadDrawerTab` instead of raw event JSON display.

### Add Full-Page Route (TODO)
Mount `ThreadFullPage` as a route in the workspace:
```
/workspace/[workspaceSlug]/task/[taskId]/thread
```

### Add to Team View (TODO)
Integrate `ThreadLaneView` into team/multi-agent board view as one lane per task.

## Extension Points

- **Tool Renderers:** Custom UI per tool registered at `registerToolRenderer()`
- **Data Loader:** Pass your own `loader` function to feed different data sources

## Design Notes

### Single Source of Truth
All three chromes render the exact same `Thread` component with identical data. If Tool UI (5.3) adds a new feature to `Thread`, it appears instantly in all three layouts.

### Reuses P5.7 Hook
`useRunEventStream` handles polling, batching (50ms), and seq-based merging. Don't rebuild this.

### No Layout Divergence
By using the same component in three contexts, we prevent:
- "sidebar chat shows X but full page shows Y"
- Separate state machines for each view
- Maintenance burden of three implementations

If a UI tweak is needed, it's one change in `Thread`, not three.

## Demo Routes

- `/thread-full-page` — ThreadFullPage with first task
- `/thread-lane-demo` — ThreadLaneView grid with first 4 tasks
- Task drawer's Sessions tab — ThreadDrawerTab (live)
