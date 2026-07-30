"use client";

import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import {
  Archive,
  ChevronDown,
  Download,
  Ellipsis,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { HistoryRefreshButton } from "@/components/history/history-refresh-button";
import { TestDataControls } from "@/components/history/test-data-controls";
import { BulkActivityArchiveButton } from "@/components/history/bulk-activity-archive-button";
import type {
  BulkActivityArchivePreview,
  SampleHistoryArchivePreview,
} from "@/services/archive";

export function HistoryMoreMenu({
  exportWeeks,
  testSessionCount,
  samplePreview,
  activityArchivePreview,
}: {
  exportWeeks: string;
  testSessionCount: number;
  samplePreview: SampleHistoryArchivePreview | null;
  activityArchivePreview: BulkActivityArchivePreview;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button variant="outline" aria-label="More History actions" />}
      >
        <Ellipsis className="size-4" aria-hidden="true" />
        More
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="w-[min(20rem,calc(100vw-2rem))] rounded-2xl border bg-popover p-3 text-popover-foreground shadow-lg outline-none transition data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Popover.Title className="px-1 text-sm font-semibold">
              History actions
            </Popover.Title>
            <Popover.Description className="mt-0.5 px-1 text-xs text-muted-foreground">
              Export, refresh, or manage recoverable History records.
            </Popover.Description>
            <div className="mt-3 grid gap-2">
              <a
                href={`/api/export/csv?entity=sets&weeks=${exportWeeks}`}
                download
                className={buttonVariants({
                  variant: "outline",
                  className: "justify-start",
                })}
              >
                <Download className="size-4" aria-hidden="true" />
                Export this period
              </a>
              <Link
                href="/export"
                className={buttonVariants({
                  variant: "outline",
                  className: "justify-start",
                })}
              >
                <Download className="size-4" aria-hidden="true" />
                All export options
              </Link>
              <HistoryRefreshButton />
              <Link
                href="/archive"
                className={buttonVariants({
                  variant: "outline",
                  className: "justify-start",
                })}
              >
                <Archive className="size-4" aria-hidden="true" />
                Open Archive
              </Link>
              <div className="border-t pt-2">
                <TestDataControls
                  testSessionCount={testSessionCount}
                  samplePreview={samplePreview}
                />
              </div>
              <BulkActivityArchiveButton preview={activityArchivePreview} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
