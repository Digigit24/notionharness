import { cn } from '@/lib/utils'
import { statusColorClasses } from '@/lib/status-colors'
import type { TaskStatus } from '@/payload-types'

// Phase C, C5 — "one geometry for status. Dashed ring plus pie-fill;
// category drives the shape, custom colour changes only the tint." One of
// the two C5 items with a concrete spec left unbuilt after the ease/
// duration/faint tokens (see AGENTS.md's Phase C notes on why status
// geometry and the type scale needed real design judgment rather than a
// mechanical token addition).
//
// The 7 fixed `TaskStatus.category` values (collections/TaskStatuses.ts —
// board grouping, automation, and the broker all read this, never the
// free-text `name`) each get one fixed shape; `color` (a per-status hue
// token, same one the column-header pill already uses via
// `statusColorClasses`) only changes the tint — applied here by reusing
// that same function's `text-*`/`dark:text-*` classes and drawing every
// SVG stroke as `currentColor`, so this icon and the existing pill can
// never visually disagree about what a given status's color actually is.
//
//   backlog     — dashed, empty ring (not yet committed to)
//   todo        — solid, empty ring (committed, not started)
//   inProgress  — ring filled to 50%
//   inReview    — ring filled to 75%
//   done        — ring filled to 100% (a full circle)
//   blocked     — a half-filled ring with a diagonal bar through it
//   cancelled   — a faint ring with an X through it
const FILL_FRACTION: Record<TaskStatus['category'], number> = {
  backlog: 0,
  todo: 0,
  inProgress: 0.5,
  inReview: 0.75,
  done: 1,
  blocked: 0.5,
  cancelled: 0,
}

export function StatusIcon({
  category,
  color,
  size = 14,
  className,
}: {
  category: TaskStatus['category']
  color?: string | null
  size?: number
  className?: string
}) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  const fill = FILL_FRACTION[category]
  const colorClass = statusColorClasses(color)
    .split(' ')
    .filter((c) => c.startsWith('text-') || c.startsWith('dark:text-'))
    .join(' ')

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn('shrink-0', colorClass, className)}
    >
      {category === 'cancelled' ? (
        <>
          <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.4" opacity={0.45} />
          <path d="M4.6 4.6L9.4 9.4M9.4 4.6L4.6 9.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            opacity={0.35}
            strokeDasharray={category === 'backlog' ? '1.6 1.6' : undefined}
          />
          {fill > 0 && (
            <circle
              cx="7"
              cy="7"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeDasharray={`${circumference * fill} ${circumference}`}
              strokeLinecap="round"
              transform="rotate(-90 7 7)"
            />
          )}
          {category === 'blocked' && (
            <line x1="4.3" y1="9.7" x2="9.7" y2="4.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  )
}
