"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import type { SessionEquipmentSetup } from "./types";
import type { WorkoutSetLoadEntryMeaning } from "@/lib/workout-set-outbox";
import { createClientUuid } from "@/lib/client-uuid";
import { cn } from "@/lib/utils";
import { equipmentManagementHref } from "@/lib/equipment-management-navigation";
import {
  enqueueEquipmentSelection,
  getEquipmentSelectionOutboxServerSnapshot,
  getEquipmentSelectionOutboxSnapshot,
  hasPendingEquipmentSelection,
  retryEquipmentSelection,
  subscribeToEquipmentSelectionOutbox,
  subscribeToEquipmentSelectionOutboxStatus,
} from "@/lib/equipment-selection-outbox";

// A saved selection can clear its durable outbox entry just before the
// refreshed server component tree exposes the resulting snapshot. Keep the
// automatic attempt claimed across that short remount window so a future
// exercise cannot enqueue the same expected-null command twice.
const automaticSelectionAttempts = new Set<string>();

type Props = {
  sessionExerciseId: string;
  exerciseName: string;
  ownerId: string;
  sessionId: string;
  setup: SessionEquipmentSetup;
  loadEntryMeaning: WorkoutSetLoadEntryMeaning;
  onLoadEntryMeaningChange: (meaning: WorkoutSetLoadEntryMeaning) => void;
  onReplaceForToday?: () => void;
  onSkipExercise?: () => void;
  futureProgramReplacement?: {
    href: string;
    dayName: string;
    plannedExerciseName: string;
  } | null;
};

export function EquipmentSetupPanel({
  sessionExerciseId,
  exerciseName,
  ownerId,
  sessionId,
  setup,
  loadEntryMeaning,
  onLoadEntryMeaningChange,
  onReplaceForToday,
  onSkipExercise,
  futureProgramReplacement = null,
}: Props) {
  const router = useRouter();
  const automaticOption = setup.decisionState === "ready" && setup.options.length === 1
    ? setup.options[0]
    : null;
  const automatic = automaticOption != null && setup.currentSnapshotId == null;
  const automaticAttemptKey = automaticOption == null
    ? null
    : [
        ownerId,
        sessionId,
        sessionExerciseId,
        setup.sourceExerciseId,
        automaticOption.key,
      ].join(":");
  const [choice, setChoice] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const automaticStarted = useRef<string | null>(null);
  const [automaticAttemptedKey, setAutomaticAttemptedKey] = useState<
    string | null
  >(() =>
    automaticAttemptKey != null && automaticSelectionAttempts.has(automaticAttemptKey)
      ? automaticAttemptKey
      : null,
  );
  const outbox = useSyncExternalStore(
    subscribeToEquipmentSelectionOutbox,
    getEquipmentSelectionOutboxSnapshot,
    getEquipmentSelectionOutboxServerSnapshot,
  );
  const pendingEntries = useMemo(
    () => outbox.entries.filter((entry) =>
      entry.ownerId === ownerId && entry.sessionId === sessionId &&
      entry.sessionExerciseId === sessionExerciseId),
    [outbox.entries, ownerId, sessionExerciseId, sessionId],
  );
  const latestPending = pendingEntries.at(-1) ?? null;
  const pending = pendingEntries.some((entry) => entry.status === "queued");
  const failed = pendingEntries.find((entry) => entry.status === "needs_attention") ?? null;
  const automaticRetryAvailable = automatic &&
    automaticAttemptedKey === automaticAttemptKey &&
    pendingEntries.length === 0;
  const selectedOption = useMemo(
    () => setup.options.find((option) => option.key === choice) ?? null,
    [choice, setup.options],
  );

  async function apply(option: SessionEquipmentSetup["options"][number], provenance: "auto_unique" | "user_selected") {
      setMessage(null);
      if (option.loadEntryMeaning) onLoadEntryMeaningChange(option.loadEntryMeaning);
      const result = await enqueueEquipmentSelection({
        operation: "select",
        ownerId,
        sessionId,
        sessionExerciseId,
        equipmentItemId: option.equipmentItemId,
        attachmentItemId: option.attachmentItemId,
        expectedCurrentSnapshotId: setup.currentSnapshotId,
        predecessorSelectionClientKey: latestPending?.clientKey ?? null,
        clientKey: createClientUuid(),
        provenance,
        equipmentLabel: option.equipmentLabel,
        attachmentLabel: option.attachmentLabel,
      });
      if (!result.ok) setMessage(result.reason);
  }

  useEffect(() => subscribeToEquipmentSelectionOutboxStatus((event) => {
    if (event.sessionExerciseId !== sessionExerciseId) return;
    if (event.type === "saved") router.refresh();
  }), [router, sessionExerciseId]);

  useEffect(() => {
    if (setup.currentSnapshotId != null) {
      if (automaticAttemptKey != null) {
        automaticSelectionAttempts.delete(automaticAttemptKey);
      }
      automaticStarted.current = null;
      return;
    }
    // Read storage again at effect time: the hydration snapshot can briefly be
    // empty even though a command from this page is already durable locally.
    const alreadyQueued = hasPendingEquipmentSelection(
      getEquipmentSelectionOutboxSnapshot(),
      { ownerId, sessionId, sessionExerciseId },
    );
    if (!automatic || automaticAttemptKey == null || pending || alreadyQueued) return;
    if (
      automaticStarted.current === automaticAttemptKey ||
      automaticSelectionAttempts.has(automaticAttemptKey)
    ) {
      setAutomaticAttemptedKey(automaticAttemptKey);
      return;
    }
    automaticStarted.current = automaticAttemptKey;
    automaticSelectionAttempts.add(automaticAttemptKey);
    setAutomaticAttemptedKey(automaticAttemptKey);
    void apply(automaticOption, "auto_unique");
    // The snapshot id changes after the refresh, preventing a second request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automatic, automaticAttemptKey, setup.currentSnapshotId]);

  const pendingLabel = latestPending?.operation === "select" && latestPending.equipmentLabel
    ? `${latestPending.equipmentLabel}${latestPending.attachmentLabel ? ` · ${latestPending.attachmentLabel}` : ""}`
    : null;
  const currentLabel = pendingLabel ?? (setup.currentEquipmentLabel == null
    ? null
    : `${setup.currentEquipmentLabel}${setup.currentAttachmentLabel ? ` · ${setup.currentAttachmentLabel}` : ""}`);
  const guidance = selectedOption?.guidance ??
    (loadEntryMeaning === "per_stack" || loadEntryMeaning === "combined_stacks"
      ? setup.currentGuidanceByLoadEntryMeaning[loadEntryMeaning]
      : null) ??
    setup.currentGuidance;

  const compactSettledSetup =
    setup.currentSnapshotId != null &&
    currentLabel != null &&
    setup.currentSelectionAvailable &&
    setup.options.length <= 1 &&
    setup.loadEntryMeaningChoices.length === 0 &&
    !pending &&
    failed == null &&
    message == null;

  const configurationIncomplete =
    setup.decisionState === "configuration_incomplete";
  const equipmentConflict =
    configurationIncomplete ||
    setup.decisionState === "unavailable" ||
    setup.decisionState === "incompatible";
  const conflictHeadingId = `equipment-decision-heading-${sessionExerciseId}`;
  const configurationIssueText = (setup.configurationIssues ?? [])
    .map((issue) =>
      `${issue.equipmentLabel}: ${issue.missingFields.join(", ")}`,
    )
    .join("; ");
  const outboxStatus = (
    <>
      {message && <p className="mt-2 text-destructive" role="alert">{message}</p>}
      {pending && (
        <p className="mt-2 text-muted-foreground" role="status">
          {pendingEntries.some((entry) => entry.attemptCount > 0)
            ? "Retrying equipment setup…"
            : "Equipment setup saved on this device and waiting to sync."}
        </p>
      )}
      {failed && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <span className="text-destructive">
            {failed.lastError ?? "Equipment setup needs attention."}
          </span>
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            variant="outline"
            onClick={() => void retryEquipmentSelection(failed.clientKey)}
          >
            Retry setup
          </Button>
        </div>
      )}
    </>
  );

  if (compactSettledSetup) {
    return (
      <section
        aria-label={`Equipment setup for ${exerciseName}`}
        className="p-3 text-sm"
      >
        <p className="break-words">
          <span className="ui-metadata text-foreground">Equipment</span>
          {" · "}
          <span className="font-medium">Using {currentLabel}</span>
        </p>
        {guidance && (
          <p className="mt-1 break-words text-muted-foreground">
            {guidance}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label={equipmentConflict ? undefined : `Equipment setup for ${exerciseName}`}
      aria-labelledby={equipmentConflict ? conflictHeadingId : undefined}
      className="p-3 text-sm"
    >
      {equipmentConflict ? (
        <div>
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <h3
                id={conflictHeadingId}
                data-active-workout-decision-heading="true"
                className="font-semibold"
              >
                {configurationIncomplete
                  ? `Equipment setup incomplete for ${exerciseName}`
                  : setup.decisionState === "unavailable"
                  ? `Equipment unavailable for ${exerciseName}`
                  : `Equipment setup incompatible for ${exerciseName}`}
              </h3>
              <p className="mt-1 text-muted-foreground">
                {configurationIncomplete
                  ? configurationIssueText
                    ? `Missing configuration — ${configurationIssueText}.`
                    : "The saved equipment is missing required machine geometry details."
                  : setup.decisionState === "unavailable"
                  ? `The equipment ${exerciseName} requires is not available in your saved inventory.`
                  : `Your saved equipment does not match ${exerciseName}'s reviewed setup.`}
                {configurationIncomplete
                  ? " Complete those details, or add another compatible item, before returning to this workout."
                  : " Choose how to handle this workout; your Program stays unchanged."}
              </p>
            </div>
          </div>
          {configurationIncomplete ? (
            <Link
              href={equipmentManagementHref({
                itemIds: setup.configurationIssues?.map((issue) => issue.equipmentItemId),
                returnTo: `/session/${sessionId}`,
              })}
              data-testid="complete-equipment-setup"
              className={cn(
                buttonVariants(),
                "mt-3 h-auto min-h-11 w-full whitespace-normal",
              )}
            >
              Complete equipment setup
            </Link>
          ) : (
            <>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  onClick={onReplaceForToday}
                  disabled={onReplaceForToday == null}
                >
                  Replace for today
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onSkipExercise}
                  disabled={onSkipExercise == null}
                >
                  Skip exercise
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Either choice for today retains the reason as equipment unavailable or incompatible.
              </p>
            </>
          )}
          {!configurationIncomplete && futureProgramReplacement ? (
            <div className="mt-3 border-t pt-3">
              <Link
                href={futureProgramReplacement.href}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto min-h-11 w-full whitespace-normal text-left",
                )}
              >
                Change future Program…
              </Link>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Opens the planned {futureProgramReplacement.plannedExerciseName} in your{" "}
                {futureProgramReplacement.dayName} Program draft. Today’s workout stays
                unchanged. Future workouts change only after you Review and Publish.
              </p>
            </div>
          ) : null}
          {outboxStatus}
        </div>
      ) : (
      <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">Equipment setup</p>
          {currentLabel ? (
            <p className="mt-1">
              {pendingLabel ? "Pending " : "Using "}<span className="font-medium">{currentLabel}</span>
              {!pendingLabel && !setup.currentSelectionAvailable && (
                <span className="text-destructive"> · no longer in the available setup list</span>
              )}
            </p>
          ) : automatic ? (
            <p className="mt-1 text-muted-foreground" aria-live="polite">
              Confirming the only available setup…
            </p>
          ) : (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              Choose the physical equipment before logging this exercise.
            </p>
          )}
        </div>
      </div>

      {(setup.selectionRequired ||
        (setup.currentSnapshotId != null &&
          (!setup.currentSelectionAvailable || setup.options.length > 1))) && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 font-medium">
            Physical setup
            <select
              className="mt-1 min-h-11 w-full rounded-md border bg-background px-3"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">Choose equipment…</option>
              {setup.options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.equipmentLabel}{option.attachmentLabel ? ` · ${option.attachmentLabel}` : ""}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            className="min-h-11"
            disabled={selectedOption == null}
            onClick={() => selectedOption && void apply(selectedOption, "user_selected")}
          >
            {currentLabel ? "Change setup" : "Choose equipment"}
          </Button>
        </div>
      )}

      {guidance && (
        <p className="mt-3 rounded-lg bg-background px-3 py-2" aria-live="polite">
          {guidance}
        </p>
      )}
      {automaticRetryAvailable && (
        <Button
          type="button"
          className="mt-3 min-h-11"
          variant="outline"
          onClick={() => automaticOption && void apply(automaticOption, "auto_unique")}
        >
          Confirm the only available setup
        </Button>
      )}
      {setup.loadEntryMeaningChoices.length > 0 && setup.currentSnapshotId && (
        <label className="mt-3 block font-medium">
          Load entry meaning
          <select
            className="mt-1 min-h-11 w-full rounded-md border bg-background px-3"
            value={loadEntryMeaning}
            onChange={(event) =>
              onLoadEntryMeaningChange(event.target.value as WorkoutSetLoadEntryMeaning)
            }
          >
            <option value="per_stack">Load shown for each stack</option>
            <option value="combined_stacks">Combined load across all stacks</option>
          </select>
          <span className="mt-1 block font-normal text-muted-foreground">
            This label is saved with each set so the number is never reinterpreted later.
          </span>
        </label>
      )}
      {outboxStatus}
      </>
      )}
    </section>
  );
}
