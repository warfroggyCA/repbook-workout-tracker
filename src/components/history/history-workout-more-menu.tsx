"use client";

import { useState } from "react";
import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Ellipsis, FilePenLine, ListTree } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ContextualNoteManager } from "@/components/contextual-notes/contextual-note-manager";
import { openContextualNoteComposer } from "@/lib/contextual-note-ui";

export function HistoryWorkoutMoreMenu() {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<Button variant="outline" aria-label="More workout actions" />}
      >
        <Ellipsis className="size-4" aria-hidden="true" />
        More
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="w-[min(20rem,calc(100vw-2rem))] rounded-2xl border bg-popover p-3 text-popover-foreground shadow-lg outline-none transition data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Popover.Title className="px-1 text-sm font-semibold">
              Workout actions
            </Popover.Title>
            <Popover.Description className="mt-0.5 px-1 text-xs text-muted-foreground">
              Add context, review saved notes, or inspect the complete record.
            </Popover.Description>
            <div className="mt-3 grid gap-2">
              <Button
                type="button"
                variant="outline"
                className="justify-start"
                data-testid="contextual-note-trigger"
                onClick={() => {
                  setOpen(false);
                  window.setTimeout(openContextualNoteComposer, 0);
                }}
              >
                <FilePenLine aria-hidden="true" /> Add workout note
              </Button>
              <div
                className="[&_[data-slot=button]]:w-full [&_[data-slot=button]]:justify-start [&_[data-slot=button]]:border [&_[data-slot=button]]:bg-background"
                onClick={() => setOpen(false)}
              >
                <ContextualNoteManager />
              </div>
              <Link
                href="#technical-record"
                onClick={() => setOpen(false)}
                className={buttonVariants({
                  variant: "outline",
                  className: "justify-start",
                })}
              >
                <ListTree className="size-4" aria-hidden="true" />
                Technical record
              </Link>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
