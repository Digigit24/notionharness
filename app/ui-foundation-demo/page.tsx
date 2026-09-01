import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export default function UiFoundationDemoPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 py-16 bg-background text-foreground">
      <div className="text-center">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          shadcn/Radix scaffold demo
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Throwaway proof that shadcn/Radix primitives render with the existing
          light/dark token layer. Tap the theme toggle, or a{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            prefers-color-scheme
          </code>{" "}
          toggle to confirm both.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon button">
          ✕
        </Button>
      </div>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Open dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Radix dialog, themed</DialogTitle>
            <DialogDescription>
              This dialog is built from <code className="font-mono text-xs">radix-ui</code>{" "}
              primitives and uses the app&apos;s shared token layer, so it matches the
              surrounding light/dark theme automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline">Cancel</Button>
            <Button>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}