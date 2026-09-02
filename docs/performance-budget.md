# Performance budget

ROADMAP B8.3 (Batch B-6 "Finish"). This is the written budget the plan asks
for. It targets the task detail page (`app/(app)/workspace/[workspaceSlug]/tasks/[taskId]/page.tsx`,
the heaviest single screen in the app — BlockSuite editor + a live comment/run
timeline + right-rail usage aggregate) as the representative worst case;
other screens (task board/list/table, project detail, inbox) are lighter and
are expected to clear the same numbers with margin.

No browser access exists in this environment (see `AGENTS.md`'s standing
environment-gotchas note), so none of the numbers below have been measured
live this session. They are stated as real, checked-in targets a future
session *with* browser or profiling access can verify against — not as
already-confirmed measurements. Where a number can be checked without a
browser (the render-stream merge cost, below), it already is.

## Targets

| Metric | Target | Why this number |
| --- | --- | --- |
| Time to first meaningful paint, task detail page, warm cache | ≤ 1.5s on a mid-tier laptop over a normal broadband connection | Matches this app's own `SEARCH_DEBOUNCE_MS` (200ms) and polling cadences (4s for run metrics/presence, 12s for ambient status) — a page that takes noticeably longer than a couple of those cycles to become usable reads as broken, not just slow. |
| Time to first meaningful paint, task detail page, cold cache (first load) | ≤ 3s | Cold-cache Next.js/BlockSuite bundle fetch is real and shouldn't be pretended away; double the warm-cache budget is the standard rule of thumb this repo has no reason to deviate from. |
| Frame time during an active SSE run stream (`useRunEventStream`'s 50ms coalesced flush → React commit → BlockSuite/Thread re-render) | ≤ 16ms per commit (60fps), ≤ 33ms permitted only during the coalesced flush itself | `useRunEventStream` already batches incoming SSE frames into ~50ms windows specifically to avoid a commit-per-token render storm (see its own header comment) — the budget here holds it to that design intent: the coalescing must actually keep each resulting commit cheap, not just infrequent. |
| Memory after 1 hour with a task detail page left open, one active run streaming the whole time | ≤ 250MB tab memory growth over the first-paint baseline | `useRunEventStream` keeps every event for every discovered run in React state for the component's lifetime (`mergeRunEvents`, unbounded) and BlockSuite keeps its full Yjs doc in memory — a page realistically left open for a work session must not grow without bound. This number is a ceiling to catch a real leak (an EventSource never closed, a growing Map with no cap), not a promise that steady growth up to it is fine. |
| Command bar search round-trip (`searchCommandBar`, debounced) | ≤ 300ms p95 | One `SEARCH_DEBOUNCE_MS` (200ms) plus real query time; already the plan's own "150–250ms guidance for debouncing full-text queries" (per `components/command-bar/command-bar.tsx`'s own comment) plus headroom for the actual Postgres round-trip. |
| Task board/list/table view, 200 tasks in view | ≤ 500ms from filter/sort/group change to re-render | `lib/task-views/data-layer.ts`'s shared filter/sort/group model is meant to be cheap enough to run on every keystroke of a filter change; TanStack Virtual already keeps the Table view's DOM node count bounded regardless of task count — this budget is really a check that the *filter computation*, not the render, stays cheap. |

## What's actually measured today

`scripts/test-render-performance.ts` (`npm run test:render-performance`) is a
real, already-existing, already-wired-in load test — not new work this
batch. It benchmarks `mergeRunEvents` (the same function `useRunEventStream`
uses to fold incoming SSE frames into the ordered event list) against a
configurable `runs × eventsPerRun` workload and fails (non-zero exit) if the
merge takes longer than a `budgetMs` argument (default 16ms for 8 runs ×
1000 events = 8000 merged events). This is a genuine regression guard for
the one piece of the streaming path that's pure, synchronous, and runnable
under plain `tsx` with no browser, no DB, and no live daemon — exactly the
kind of check this environment *can* run for real.

It is **not** wired into CI (no `.github/workflows/` or other CI config
exists in this repo as of this batch — confirmed by checking for one). It's
a `package.json` script a human or a future CI job can invoke directly:
`npm run test:render-performance` (optionally `-- <runs> <eventsPerRun>
<budgetMs>` to tune the workload).

## What's honestly not measured

Everything else in the table above — first-paint timing, frame time during
a live SSE stream as actually rendered by React/BlockSuite, real browser
memory growth — needs a browser or a profiling harness this environment does
not have. Building a *new* end-to-end render-performance script (e.g. a
Playwright trace against a running dev server) is real, non-trivial scripting
work in its own right, and forcing a shallow, unreliable version of it into
existence under this batch's time budget would be worse than not having one.
Per this batch's own explicit permission to make that call honestly: the
budget above is written and checked in; the load test that would verify the
non-`mergeRunEvents` rows is a follow-up, not attempted here.

### Follow-up: a real end-to-end load test

When browser/profiling access exists, the natural next script is
`scripts/test-page-render-performance.ts` (or a Playwright spec) that:

1. Boots (or points at) a running dev/prod server with a seeded task that has
   an active run streaming a realistic event volume (reuse
   `scripts/seed-starter-workspace.ts`'s fixtures — see B8.5 — as the seed
   source rather than hand-rolling a second one).
2. Uses the Chrome DevTools Protocol (via Playwright, already the natural
   choice given `claude-in-chrome` tooling exists elsewhere in this
   environment) to capture: time-to-first-contentful-paint, long-task count
   during a 60s streaming window, and `performance.memory` (or
   `measureUserAgentSpecificMemory()`) before/after that window.
3. Asserts each captured number against the targets table above and exits
   non-zero on a miss, matching `test-render-performance.ts`'s existing
   pass/fail convention so it can be dropped into the same CI job later.
