import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * R12-P2.2 — two variants, and the difference is not decoration.
 *
 * `pulse` (the default this file has always had) fades in place: it reads as
 * "waiting". `shimmer` sweeps a highlight across the box: it reads as
 * "arriving". Use shimmer where data really is on its way and pulse where a
 * thing is merely disabled or indeterminate — a page that shimmers forever
 * is a page that lied.
 *
 * Neither needs a reduced-motion guard of its own: `app/globals.css` already
 * collapses every animation to 0.001ms under `prefers-reduced-motion`, and
 * both variants rest on the same flat `bg-muted`, so what remains is a
 * correctly-sized grey box rather than a gradient frozen mid-sweep.
 */
function Skeleton({
  className,
  variant = "shimmer",
  ...props
}: React.ComponentProps<"div"> & { variant?: "pulse" | "shimmer" }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-muted",
        variant === "pulse" ? "animate-pulse" : "skeleton-shimmer",
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
