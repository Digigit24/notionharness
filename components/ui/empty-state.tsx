import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type EmptyStateAction =
  | { label: string; onClick: () => void; href?: never }
  | { label: string; href: string; onClick?: never }

/**
 * The one shape every empty state in the product should use: a short
 * explanation of what belongs here, plus a single control that makes it
 * happen. Keep copy to one sentence and the action to one verb.
 */
function EmptyState({
  className,
  icon,
  title,
  description,
  action,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: EmptyStateAction
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className
      )}
      {...props}
    >
      {icon && (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="font-heading text-sm font-medium text-foreground">
          {title}
        </p>
        {description && (
          <p className="max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action &&
        (action.href ? (
          <Button asChild size="sm">
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : (
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
      {children}
    </div>
  )
}

export { EmptyState }
