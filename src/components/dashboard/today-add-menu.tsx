"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  FilePenLine,
  Footprints,
  History,
  Mic,
  Plus,
} from "lucide-react";
import { QuickLogCard } from "@/components/quick-log/quick-log-card";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { openContextualNoteComposer } from "@/lib/contextual-note-ui";

export function TodayAddMenu() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size="touch"
        variant="outline"
        data-testid="today-add-menu-trigger"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" /> Add training
      </Button>
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="[--drawer-content-max-height:calc(100dvh-1rem)] [&_button]:min-h-11">
          <DrawerHeader>
            <DrawerTitle>Add training</DrawerTitle>
            <DrawerDescription>
              Record something without changing today&apos;s planned workout.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                render={<Link href="/activity/new" prefetch={false} />}
                nativeButton={false}
                variant="outline"
                className="h-auto min-h-12 justify-start whitespace-normal py-3 text-left"
                onClick={() => setOpen(false)}
              >
                <Footprints aria-hidden="true" /> Record activity
              </Button>
              <Button
                render={<Link href="/history?view=calendar" />}
                nativeButton={false}
                variant="outline"
                className="h-auto min-h-12 justify-start whitespace-normal py-3 text-left"
                onClick={() => setOpen(false)}
              >
                <History aria-hidden="true" /> Record past workout
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-12 justify-start whitespace-normal py-3 text-left"
                data-testid="contextual-note-trigger"
                onClick={() => {
                  setOpen(false);
                  window.setTimeout(openContextualNoteComposer, 0);
                }}
              >
                <FilePenLine aria-hidden="true" /> Add training note
              </Button>
            </div>
            <details className="group rounded-xl border">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="flex items-center gap-2">
                  <Mic className="size-4" aria-hidden="true" /> Quick log
                </span>
                <ChevronDown
                  className="size-4 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="border-t p-3">
                <QuickLogCard embedded />
              </div>
            </details>
          </div>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
