"use client"

import { CircleX, ListTodo, Target } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Closing this badge only cancels an input mode; it never clears a running goal. */
export function ComposerModeBadge({ mode, label, closeLabel, onClose, disabled = false }: {
  mode: "plan" | "goal"
  label: string
  closeLabel: string
  onClose: () => void
  disabled?: boolean
}) {
  const ModeIcon = mode === "plan" ? ListTodo : Target
  return (
    <span className="group/mode inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-secondary pr-2.5 text-sm text-secondary-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-full"
        aria-label={closeLabel}
        disabled={disabled}
        onClick={onClose}
      >
        <span className="grid size-4" aria-hidden="true">
          <ModeIcon className="col-start-1 row-start-1 transition-opacity group-hover/mode:opacity-0 group-focus-within/mode:opacity-0 [@media(hover:none)]:opacity-0 [@media(any-pointer:coarse)]:opacity-0 motion-reduce:transition-none" />
          <CircleX className="col-start-1 row-start-1 opacity-0 transition-opacity group-hover/mode:opacity-100 group-focus-within/mode:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100 motion-reduce:transition-none" />
        </span>
      </Button>
      <span>{label}</span>
    </span>
  )
}
