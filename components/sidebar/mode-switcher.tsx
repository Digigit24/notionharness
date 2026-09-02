'use client'

/**
 * Sidebar ModeSwitcher — the three-way Plan/Work/Review segmented control
 * for ROADMAP P6.5.
 *
 * What this component owns:
 *
 * - **Active-mode detection** (per docs/p6-5-plan-work-review-design.md Q3):
 *   pathname-based, server-component-free. Reads `usePathname()` and maps
 *   it to one of `plan` / `work` / `review` / `none`. Routes that match
 *   multiple patterns take the most specific one (e.g. `/tasks?task=42`
 *   is Work, not Plan, even though `task` is the Plan-mode surface).
 *
 * - **Cross-mode navigation** via the Q2 helpers in `lib/entity-links.ts`.
 *   On click, each segment computes its href by:
 *     1. identifying the source surface from the URL (page/task/review/none),
 *     2. parsing out the entity id if any,
 *     3. calling the Q2 helper with whatever join fields are derivable
 *        from the URL alone.
 *   Directions that need a DB-derived join (e.g. Task -> Review needs the
 *   task's latest review-ready run) fall back to the mode default per the
 *   design. This is intentional - "fall back to default rather than
 *   error" is the contract, and the sidebar must stay snappy without a
 *   round-trip per click.
 *
 * - **"Last Work sub-route" memory** (Q3): when the user is on a Work
 *   sub-route (`/inbox`, `/tasks`, or `/active-runs`), the sidebar's
 *   localStorage blob is updated so the next click of the Work pill from
 *   a non-Work surface lands where they were last working.
 *
 * What this component does NOT own:
 *
 * - The mode switcher's visual placement, collapse/expand logic, or
 *   workspace scoping - all of that lives in `sidebar.tsx`, which
 *   already owns the existing localStorage blob.
 *
 * - The detail/review panel for a run, the task drawer, or the task
 *   board - P6.5 explicitly reuses those untouched per the design.
 */

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  PLAN_MODE_DEFAULT,
  REVIEW_MODE_DEFAULT,
  WORK_MODE_SUBROUTES,
  planHrefForTask,
  planHrefForRun,
  planHrefForPage,
  workHrefForTask,
  workHrefForRun,
  workHrefForPage,
  reviewHrefForTask,
  reviewHrefForRun,
  reviewHrefForPage,
} from '@/lib/entity-links'

// ---------------------------------------------------------------------------
// Surface detection
// ---------------------------------------------------------------------------

/**
 * What "kind of thing" is currently occupying the main content area.
 * Drives which Q2 helper pair to use on click and which segment should
 * render as active.
 */
type Surface = 'page' | 'task' | 'review' | 'none'

/**
 * One of the three sidebar mode pills. `none` covers surfaces that don't
 * map cleanly to a mode (settings, admin, error pages) — the switcher
 * still renders, just with no segment highlighted.
 */
type Mode = 'plan' | 'work' | 'review'

interface ParsedLocation {
  mode: Mode | 'none'
  surface: Surface
  /** Entity id parsed out of the URL, if any. Strings because runIds are uuid. */
  entityId: string | null
}

/**
 * Parse the current pathname into a `(mode, surface, entityId)` triple.
 *
 * Routing rules (per the design doc Q3, with the workspace landing
 * added as Plan mode with no surface entity):
 *   /workspace/:slug/        -> Plan mode, no surface (workspace landing)
 *   /workspace/:slug         -> Plan mode, no surface (workspace landing)
 *   /p/:id (after /workspace/:slug/)  -> Plan mode, page surface, id=:id
 *   /tasks (no ?task=)       -> Work mode, no surface entity
 *   /tasks?task=:id          -> Work mode, task surface, id=:id
 *   /inbox                   -> Work mode, no surface entity
 *   /active-runs             -> Work mode, no surface entity
 *   /runs/:runId/review      -> Review mode, review surface, id=:runId
 *   /review                  -> Review mode, no surface entity
 *   anything else            -> no mode, no surface
 *
 * `useSearchParams()` is intentionally avoided here because the switcher
 * needs the *raw* query string for the task highlight; pulling in the
 * Suspense boundary that `useSearchParams` requires for SSR is a much
 * bigger change than parsing `window.location.search` lazily on the
 * client (where `usePathname` is already a client-only call).
 */
function parseLocation(pathname: string, search: string): ParsedLocation {
  // Workspace landing - Plan mode with no surface entity. Listed first
  // so the more specific patterns below can match without this one
  // swallowing the empty-tail case.
  if (/^\/workspace\/[^/]+\/?$/.test(pathname)) {
    return { mode: 'plan', surface: 'none', entityId: null }
  }

  // Plan-mode page surface.
  const pageMatch = pathname.match(/^\/workspace\/[^/]+\/p\/([^/]+)\/?$/)
  if (pageMatch) {
    return { mode: 'plan', surface: 'page', entityId: pageMatch[1] }
  }

  // Review surfaces (specific run + the landing list).
  const reviewRunMatch = pathname.match(/^\/workspace\/[^/]+\/runs\/([^/]+)\/review\/?$/)
  if (reviewRunMatch) {
    return { mode: 'review', surface: 'review', entityId: reviewRunMatch[1] }
  }
  if (/^\/workspace\/[^/]+\/review\/?$/.test(pathname)) {
    return { mode: 'review', surface: 'none', entityId: null }
  }

  // Work sub-routes.
  const taskParams = new URLSearchParams(search)
  const taskId = taskParams.get('task')
  if (/^\/workspace\/[^/]+\/tasks\/?$/.test(pathname)) {
    if (taskId) {
      return { mode: 'work', surface: 'task', entityId: taskId }
    }
    return { mode: 'work', surface: 'none', entityId: null }
  }
  if (/^\/workspace\/[^/]+\/inbox\/?$/.test(pathname)) {
    return { mode: 'work', surface: 'none', entityId: null }
  }
  if (/^\/workspace\/[^/]+\/active-runs\/?$/.test(pathname)) {
    return { mode: 'work', surface: 'none', entityId: null }
  }

  return { mode: 'none', surface: 'none', entityId: null }
}

// ---------------------------------------------------------------------------
// Href computation
// ---------------------------------------------------------------------------

/**
 * Compute the three cross-mode hrefs for the current location. The
 * returned paths are workspace-relative (no `/workspace/{slug}/` prefix)
 * — the caller prepends that. Helpers that need DB-derived joins
 * (latest review-ready run id, first linked task id, run.taskId, etc.)
 * fall back to the mode default rather than throwing — the helper's
 * contract is "fall back when the link doesn't exist yet", which keeps
 * this component synchronous and database-free.
 *
 * Returns `null` for `work` when on a run review (no taskId in scope
 * from the URL alone) per the design's "falls through to Plan" rule:
 * Work has nothing to show for a page-scoped run, and the helper
 * surfaces that signal rather than silently absorbing a Plan URL into
 * a Work-mode href. The caller renders the Work segment as `/inbox`
 * so the user can still navigate to Work mode but never lands on a
 * page editor from a click that was labeled "Work".
 *
 * Sanity-check matrix (each href must come from the TARGET mode's own
 * route list - not the surface you're already on):
 *
 *   Surface        Plan                  Work              Review
 *   ----------     ------------------    ---------------   -------------------
 *   page (/p/:id)  /p/:id                /inbox            /review
 *   task /tasks?   /workspace/:slug      /tasks?task=:id   /review
 *                  task=:id (no Tasks.page from URL)
 *   review         /workspace/:slug      /inbox            /runs/:runId/review
 *   /runs/:id/rev  (no taskPageId/pageId  (no taskId from
 *                   from URL)             URL)            self
 *   none           /workspace/:slug      /inbox            /review
 *                  (PLAN_MODE_DEFAULT)   (Work default)    (REVIEW_MODE_DEFAULT)
 *
 * Any case that doesn't match the above is a bug - either the helper
 * is computing the wrong URL shape or the active-mode detection is
 * drifting away from the design's mode definitions. Re-check both.
 */
function computeLinks(loc: ParsedLocation): {
  plan: string
  work: string | null
  review: string
} {
  const { surface, entityId } = loc

  // Plan-mode surface (a page or the workspace landing). Plan = self
  // (the page is the Plan editor). Work = reverse lookup (page's
  // linked task, or /inbox default). Review = run for the page's task.
  if (surface === 'page' && entityId) {
    return {
      // Self in Plan mode.
      plan: planHrefForPage({ id: entityId }),
      // firstLinkedTaskId isn't in the URL alone, so fall back to the
      // Work default (/inbox). The mode-switcher could lazily prefetch
      // via an API route for the smart case; deferred to a follow-up.
      work: workHrefForPage({ firstLinkedTaskId: null }),
      // latestReviewReadyRunId isn't in the URL alone, so fall back to
      // the Review default (/review).
      review: reviewHrefForPage({ latestReviewReadyRunId: null }),
    }
  }

  // Work-mode surface (a task on the tasks board). Work = self (the
  // tasks board IS the Work surface). Plan = the task's linked page
  // editor, or Plan's default (workspace landing) when no page yet.
  if (surface === 'task' && entityId) {
    return {
      // task.page isn't in the URL, so fall back to PLAN_MODE_DEFAULT.
      // Most tasks today have no linked page yet - the workspace landing
      // is the right Plan-mode placeholder in that case.
      plan: planHrefForTask({ page: null }),
      // Self in Work mode.
      work: workHrefForTask({ id: entityId }),
      // latestReviewReadyRunId isn't in the URL alone.
      review: reviewHrefForTask({ latestReviewReadyRunId: null }),
    }
  }

  // Review-mode surface (a specific run's review panel). Review = self.
  // Plan = the run's task's linked page, or run.pageId directly, or
  // Plan default. Work = the run's task's drawer, or null for page-
  // scoped runs (no taskId) - see the fall-through note above.
  if (surface === 'review' && entityId) {
    const work = workHrefForRun({ taskId: null })
    return {
      // Neither taskPageId nor pageId is in the URL alone. Fall back to
      // PLAN_MODE_DEFAULT (workspace landing).
      plan: planHrefForRun({ taskPageId: null, pageId: null }),
      // For page-scoped runs this returns null - the caller renders the
      // Work segment with the /inbox default in that case, since Work
      // has nothing more specific to show.
      work,
      // Self in Review mode.
      review: reviewHrefForRun({ id: entityId }),
    }
  }

  // No surface - all three segments are mode defaults.
  return {
    plan: PLAN_MODE_DEFAULT,
    work: 'inbox',
    review: REVIEW_MODE_DEFAULT,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ModeSwitcherProps {
  workspaceSlug: string
  /**
   * Last Work sub-route remembered from the sidebar's localStorage blob.
   * Honored when the user clicks Work from a non-Work surface so they
   * land where they were last working. May be `null` if the sidebar
   * hasn't mounted yet (server-side first paint) — `computeLinks`
   * falls back to `inbox` in that case.
   */
  lastWorkSubRoute: string | null
}

/**
 * Read the current mode + entity from the URL on the client. Wraps
 * `usePathname` + a `useEffect` that mirrors `window.location.search`
 * into state so a `?task=` highlight updates the switcher without a
 * full route change.
 */
function useLocation(): ParsedLocation {
  const pathname = usePathname() ?? ''
  const [search, setSearch] = useState('')

  useEffect(() => {
    // `useSearchParams` would force a Suspense boundary at every consumer;
    // a tiny window listener is cheaper for a sidebar widget.
    const sync = () => setSearch(window.location.search)
    sync()
    window.addEventListener('popstate', sync)
    // Next.js client-side navigation doesn't fire `popstate`, but it
    // does update `window.location.search` synchronously before the new
    // route commits; poll on a microtask via `requestAnimationFrame`
    // after the pathname hook has settled. Cheap and good enough for a
    // sidebar that re-renders on every pathname change anyway.
    const raf = requestAnimationFrame(sync)
    return () => {
      window.removeEventListener('popstate', sync)
      cancelAnimationFrame(raf)
    }
  }, [pathname])

  return parseLocation(pathname, search)
}

export function ModeSwitcher({ workspaceSlug, lastWorkSubRoute }: ModeSwitcherProps) {
  const loc = useLocation()
  const links = computeLinks(loc)

  // Honor the "last Work sub-route" memory when the user is currently on
  // a non-Work surface and clicks Work. On a Work surface, the Work
  // segment is already the "current" segment and we don't navigate.
  //
  // For a page-scoped-run review (where `computeLinks` returned null for
  // work per the design's "Work has nothing to show it" rule), the
  // Work segment renders as a plain /inbox link rather than a fake
  // page-editor URL - Work mode has nothing more specific to show.
  const workTail =
    links.work !== null
      ? loc.mode === 'work'
        ? links.work
        : resolveWorkHref(lastWorkSubRoute)
      : 'inbox'

  // Build the full href from a workspace-relative tail. Empty tail
  // (PLAN_MODE_DEFAULT for the workspace landing) means the bare
  // `/workspace/{slug}` URL, not `/workspace/{slug}/`.
  const fullHref = (tail: string) => {
    const clean = tail.replace(/^\/+/, '')
    return clean ? `/workspace/${workspaceSlug}/${clean}` : `/workspace/${workspaceSlug}`
  }

  const segments: Array<{ key: Mode; label: string; href: string; isActive: boolean }> = [
    { key: 'plan', label: 'Plan', href: fullHref(links.plan), isActive: loc.mode === 'plan' },
    { key: 'work', label: 'Work', href: fullHref(workTail), isActive: loc.mode === 'work' },
    { key: 'review', label: 'Review', href: fullHref(links.review), isActive: loc.mode === 'review' },
  ]

  return (
    <div
      role="tablist"
      aria-label="Mode"
      className="nf-mode-switcher inline-flex items-center rounded-md border border-[var(--nf-border,#e5e7eb)] bg-[var(--nf-surface-muted,#f9fafb)] p-0.5 text-xs"
    >
      {segments.map((seg) => (
        <Link
          key={seg.key}
          role="tab"
          aria-selected={seg.isActive}
          href={seg.href}
          prefetch={false}
          className={
            'inline-flex items-center rounded px-2.5 py-1 font-medium transition-colors ' +
            (seg.isActive
              ? 'bg-[var(--nf-surface,#fff)] text-[var(--nf-fg,#111827)] shadow-sm'
              : 'text-[var(--nf-fg-muted,#6b7280)] hover:text-[var(--nf-fg,#111827)]')
          }
        >
          {seg.label}
        </Link>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Work-mode href honoring the sidebar's "last Work sub-route"
 * memory. Falls back to `inbox` when the preference is unknown / unset.
 * Inline re-export of `workModeDefault` keeps the sidebar's localStorage
 * shape decoupled from this component's import surface.
 */
function resolveWorkHref(preferred: string | null): string {
  return (WORK_MODE_SUBROUTES as readonly string[]).includes(preferred ?? '')
    ? (preferred as string)
    : 'inbox'
}
