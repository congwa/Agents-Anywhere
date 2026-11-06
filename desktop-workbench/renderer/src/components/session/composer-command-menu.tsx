"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export type ComposerCommandItem = {
  id: string
  hint?: string
  description: string
  disabled?: boolean
}

/** Shared slash menu for session replies and new-session creation. */
export function ComposerCommandMenu({ id, label, items, activeIndex, onHighlight, onChoose, children }: {
  id: string
  label: string
  items: ComposerCommandItem[]
  activeIndex: number
  onHighlight: (index: number) => void
  onChoose: (id: string) => void
  children?: React.ReactNode
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`${id}-${index}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          aria-disabled={Boolean(item.disabled)}
          className={cn("flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left", index === activeIndex && "bg-accent text-accent-foreground")}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onChoose(item.id)}
        >
          <span className={cn("code-mono shrink-0 text-xs", item.disabled ? "text-muted-foreground" : "text-primary")}>
            /{item.id}{item.hint ? <span className="text-muted-foreground"> {item.hint}</span> : null}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-xs", item.disabled ? "text-muted-foreground/80" : "text-muted-foreground")}>{item.description}</span>
        </button>
      ))}
      {items.length === 0 ? children : null}
    </div>
  )
}
