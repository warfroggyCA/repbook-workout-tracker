import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";
import { OccurrenceSaveStatus } from "@/components/session/occurrence-save-status";

vi.mock("@/app/actions/sessions", () => ({
  mutateOccurrence: vi.fn(),
}));

let Tray: typeof import("@/components/session/occurrence-mutation-outbox-sync")["OccurrenceMutationOutboxTray"];

beforeAll(async () => {
  ({ OccurrenceMutationOutboxTray: Tray } = await import(
    "@/components/session/occurrence-mutation-outbox-sync"
  ));
});

function entry(status: OccurrenceMutationOutboxEntry["status"]) {
  return {
    clientKey: "10000000-0000-4000-8000-000000000001",
    ownerId: "20000000-0000-4000-8000-000000000001",
    sessionId: "30000000-0000-4000-8000-000000000001",
    occurrenceId: "40000000-0000-4000-8000-000000000001",
    label: "Band pull-aparts",
    expectedRevision: 0,
    operation: "skip" as const,
    reason: "user_skipped",
    note: null,
    createdAtISO: "2026-07-21T12:00:00.000Z",
    status,
    attemptCount: status === "queued" ? 0 : 6,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    lastError: status === "queued" ? null : "Automatic retry paused.",
  } satisfies OccurrenceMutationOutboxEntry;
}

describe("occurrence mutation queue presentation", () => {
  it("stays hidden when there is nothing that could block finish", () => {
    expect(
      renderToStaticMarkup(
        <Tray entries={[]} storageError={null} onWake={() => undefined} />,
      ),
    ).toBe("");
  });

  it("shows saving and attention states with an explicit queue control", () => {
    const saving = renderToStaticMarkup(
      <Tray entries={[entry("queued")]} storageError={null} onWake={() => undefined} />,
    );
    expect(saving).toContain("Open unsaved workout changes");
    expect(saving).toContain("1 change saving");
    expect(saving).toContain(
      "bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)]",
    );
    expect(saving).toContain("min-h-11");
    expect(saving).toContain("lg:bottom-[5.75rem]");

    const attention = renderToStaticMarkup(
      <Tray entries={[entry("needs_attention")]} storageError={null} onWake={() => undefined} />,
    );
    expect(attention).toContain("Workout changes need attention");
  });

  it("keeps the exact row truthful through saving, failure, retry, discard, and saved states", () => {
    const unsaved = renderToStaticMarkup(
      <OccurrenceSaveStatus
        entry={entry("queued")}
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(unsaved).toContain("Skip · Unsaved");
    expect(unsaved).toContain("Discard device copy");

    const saving = renderToStaticMarkup(
      <OccurrenceSaveStatus
        entry={entry("queued")}
        runtimeState="saving"
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(saving).toContain("Skip · Saving");
    expect(saving).toContain("Discard device copy");
    expect(saving).not.toContain("Retry save</button>");

    const transientFailure = renderToStaticMarkup(
      <OccurrenceSaveStatus
        entry={{
          ...entry("queued"),
          attemptCount: 1,
          nextAttemptAtISO: "2026-07-21T12:00:01.000Z",
          lastAttemptAtISO: "2026-07-21T12:00:00.000Z",
          lastError:
            "We couldn't save this yet. We'll keep trying when you're back online.",
        }}
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(transientFailure).toContain("Skip · Failed");
    expect(transientFailure).toContain("Retry save</button>");
    expect(transientFailure).toContain("Discard device copy");

    const failed = renderToStaticMarkup(
      <OccurrenceSaveStatus
        entry={entry("needs_attention")}
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(failed).toContain("Skip · Failed");
    expect(failed).toContain("Retry save</button>");
    expect(failed).toContain("Discard device copy");

    const saved = renderToStaticMarkup(
      <OccurrenceSaveStatus
        entry={null}
        saved
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(saved).toContain("Saved");
  });
});
