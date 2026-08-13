"use client";

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CloudUpload,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { logSet, setSessionEquipmentSelection } from "@/app/actions/sessions";
import type { LogSetInput } from "@/lib/session-action-validation";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  getWorkoutSetOutboxServerSnapshot,
  getWorkoutSetOutboxSnapshot,
  discardQuarantinedWorkoutSet,
  publishWorkoutSetOutboxEvent,
  releaseQueuedWorkoutSetBackoff,
  recordWorkoutSetNeedsAttentionUnlocked,
  recordWorkoutSetTransientFailureUnlocked,
  releaseWorkoutSetOrderBlockerOutboxEntry,
  removeWorkoutSet,
  removeWorkoutSetUnlocked,
  retryWorkoutSet,
  subscribeToWorkoutSetOutbox,
  WORKOUT_SET_OUTBOX_CHANGE_EVENT,
  withOutboxLock,
  type WorkoutSetOutboxEntry,
  type QuarantinedWorkoutSetOutboxEntry,
  bindWorkoutSetsToEquipmentSelectionUnlocked,
} from "@/lib/workout-set-outbox";
import {
  acknowledgeEquipmentSelectionUnlocked,
  discardQuarantinedEquipmentSelection,
  getEquipmentSelectionOutboxServerSnapshot,
  getEquipmentSelectionOutboxSnapshot,
  markEquipmentSelectionNeedsAttentionUnlocked,
  markEquipmentSelectionTransientFailureUnlocked,
  nextWorkoutCommand,
  publishEquipmentSelectionOutboxEvent,
  releaseQueuedEquipmentSelectionBackoff,
  removeEquipmentSelection,
  retryEquipmentSelection,
  subscribeToEquipmentSelectionOutbox,
  type EquipmentSelectionOutboxEntry,
  type QuarantinedEquipmentSelection,
} from "@/lib/equipment-selection-outbox";
import {
  clearRestTimerForIdentity,
  createRestTimer,
  writeRestTimer,
} from "@/lib/rest-timer";
import { effortChoiceForLegacyRpe } from "@/lib/active-workout-language";
import {
  LIMITATION_CAUSE_LABELS,
  TECHNIQUE_ISSUE_LABELS,
} from "@/lib/set-exception-context";
import { formatPainEvidence } from "@/lib/pain-evidence";
import {
  deploymentRecoveryRequired,
  reportDeploymentMismatch,
} from "@/lib/deployment-recovery";

const activeOwners = new Set<string>();

const TRANSIENT_SET_FAILURE =
  "We couldn't save this set yet. We'll keep trying when you're back online.";
const UPDATED_SET_FAILURE =
  "Repbook was updated. This set is safe on this device and will retry after you reload.";
const UPDATED_EQUIPMENT_FAILURE =
  "Repbook was updated. This equipment choice is safe on this device and will retry after you reload.";

function formatRetainedContext(entry: WorkoutSetOutboxEntry) {
  const context: string[] = [];
  if (entry.rir != null) context.push(`RIR ${entry.rir}`);
  if (entry.rpe != null) {
    const category = effortChoiceForLegacyRpe(entry.rpe);
    context.push(category
      ? `${category.label} (RPE ${entry.rpe})`
      : `RPE ${entry.rpe}`);
  }
  if (entry.techniqueIssue != null) {
    context.push(`Technique: ${TECHNIQUE_ISSUE_LABELS[entry.techniqueIssue]}`);
  }
  if (entry.limitationCause != null) {
    context.push(`Limited by: ${LIMITATION_CAUSE_LABELS[entry.limitationCause]}`);
  }
  if (entry.pain != null) {
    context.push(formatPainEvidence({ ...entry.pain, source: "set_exception" }));
  }
  return context.length === 0 ? "" : ` · ${context.join(" · ")}`;
}

function formatRetainedWorkout(entry: WorkoutSetOutboxEntry) {
  return entry.workoutName ?? `Workout ${entry.sessionId.slice(0, 8)}`;
}

function formatRetainedMeasurement(entry: WorkoutSetOutboxEntry) {
  if (entry.metricType === "duration") {
    return `${entry.durationSeconds} sec`;
  }
  if (entry.metricType === "distance_duration") {
    return entry.durationSeconds == null
      ? `${entry.distanceKm} km`
      : `${entry.distanceKm} km · ${entry.durationSeconds} sec`;
  }
  const repetitions = `${entry.reps} reps`;
  if (entry.metricType === "assisted_reps") {
    return `Assistance: ${entry.weight} ${entry.weightUnit} · ${repetitions}`;
  }
  return entry.weight == null
    ? repetitions
    : `${entry.weight} ${entry.weightUnit} × ${repetitions}`;
}

function serverSetCommand(entry: WorkoutSetOutboxEntry): LogSetInput {
  const common = {
    sessionExerciseId: entry.sessionExerciseId,
    occurrenceId: entry.occurrenceId,
    expectedOccurrenceRevision: entry.expectedOccurrenceRevision,
    performedExerciseId: entry.performedExerciseId,
    performedSemanticsVersion: entry.performedSemanticsVersion,
    performedLoadType: entry.performedLoadType,
    performedLoadSemantics: entry.performedLoadSemantics,
    setNo: entry.setNo,
    rpe: entry.rpe,
    rir: entry.rir,
    techniqueIssue: entry.techniqueIssue,
    limitationCause: entry.limitationCause,
    pain: entry.pain,
    note: entry.note,
    clientKey: entry.clientKey,
    equipmentSnapshotId: entry.equipmentSnapshotId,
    loadEntryMeaning: entry.loadEntryMeaning,
    observedCompletedAtISO: entry.observedCompletedAtISO,
  };
  switch (entry.metricType) {
    case "weight_reps":
    case "reps":
    case "assisted_reps":
    case "duration":
    case "distance_duration":
      return {
        ...common,
        metricType: entry.metricType,
        weight: entry.weight,
        weightUnit: entry.weightUnit,
        reps: entry.reps,
        distanceKm: entry.distanceKm,
        durationSeconds: entry.durationSeconds,
      } as LogSetInput;
  }
}

export async function syncNextEntry(
  ownerId: string,
  drainReady = false,
  drainDepth = 0,
) {
  if (deploymentRecoveryRequired()) return;
  if (activeOwners.has(ownerId)) return;
  activeOwners.add(ownerId);
  let attempted = false;
  try {
    await withOutboxLock(async () => {
      const command = nextWorkoutCommand(
        ownerId,
        getWorkoutSetOutboxSnapshot().entries,
        getEquipmentSelectionOutboxSnapshot().entries,
      );
      if (!command || (typeof navigator !== "undefined" && !navigator.onLine)) {
        return;
      }
      attempted = true;
      if (command.kind === "selection") {
        const entry = command.entry;
        publishEquipmentSelectionOutboxEvent({
          type: "saving",
          clientKey: entry.clientKey,
          sessionExerciseId: entry.sessionExerciseId,
          retrying: entry.attemptCount > 0 || entry.lastAttemptAtISO != null,
        });
        try {
          const result = await setSessionEquipmentSelection(entry.operation === "select"
            ? {
                operation: "select",
                sessionExerciseId: entry.sessionExerciseId,
                equipmentItemId: entry.equipmentItemId!,
                attachmentItemId: entry.attachmentItemId,
                expectedCurrentSnapshotId: entry.expectedCurrentSnapshotId,
                clientKey: entry.clientKey,
                provenance: entry.provenance!,
              }
            : {
                operation: "clear",
                sessionExerciseId: entry.sessionExerciseId,
                expectedCurrentSnapshotId: entry.expectedCurrentSnapshotId,
                clientKey: entry.clientKey,
              });
          if (result.outcome === "applied" || result.outcome === "no_change" || result.outcome === "replayed") {
            const bound = bindWorkoutSetsToEquipmentSelectionUnlocked(
              entry.clientKey,
              result.snapshotId,
              result.occurrenceStates,
            );
            if (!bound.ok) {
              markEquipmentSelectionNeedsAttentionUnlocked(entry.clientKey, bound.reason);
              publishEquipmentSelectionOutboxEvent({ type: "failed", clientKey: entry.clientKey, sessionExerciseId: entry.sessionExerciseId });
              return;
            }
            const acknowledged = acknowledgeEquipmentSelectionUnlocked(
              entry.clientKey,
              result.snapshotId,
              result.occurrenceStates,
            );
            if (!acknowledged.ok) {
              markEquipmentSelectionNeedsAttentionUnlocked(entry.clientKey, acknowledged.reason);
              return;
            }
            publishEquipmentSelectionOutboxEvent({
              type: "saved", clientKey: entry.clientKey,
              sessionExerciseId: entry.sessionExerciseId,
              snapshotId: result.snapshotId,
              occurrenceStates: result.occurrenceStates,
            });
            return;
          }
          const reason = result.outcome === "stale"
            ? "The equipment setup changed elsewhere. Refresh before retrying this choice."
            : result.outcome === "not_active"
              ? "This workout is no longer active."
              : result.outcome === "conflict"
                ? "This equipment command identity belongs to different values."
                : "That exact equipment setup is no longer available.";
          markEquipmentSelectionNeedsAttentionUnlocked(entry.clientKey, reason);
          publishEquipmentSelectionOutboxEvent({ type: "failed", clientKey: entry.clientKey, sessionExerciseId: entry.sessionExerciseId });
        } catch (error) {
          const deploymentMismatch = reportDeploymentMismatch(error);
          const marked = markEquipmentSelectionTransientFailureUnlocked(
            entry.clientKey,
            deploymentMismatch
              ? UPDATED_EQUIPMENT_FAILURE
              : "The server could not be reached. This equipment choice will retry automatically.",
          );
          publishEquipmentSelectionOutboxEvent({
            type: marked.ok && marked.entry?.status !== "needs_attention" ? "saving" : "failed",
            clientKey: entry.clientKey,
            sessionExerciseId: entry.sessionExerciseId,
            ...(marked.ok && marked.entry?.status !== "needs_attention" ? { retrying: true } : {}),
          } as Parameters<typeof publishEquipmentSelectionOutboxEvent>[0]);
        }
        return;
      }
      const entry = command.entry;
      publishWorkoutSetOutboxEvent({
        type: "saving",
        clientKey: entry.clientKey,
        sessionId: entry.sessionId,
        retrying: entry.attemptCount > 0 || entry.lastAttemptAtISO != null,
      });
      try {
        const result = await logSet(serverSetCommand(entry));
        if (result.outcome !== "saved") {
          const orderBlocker = result.outcome === "set_order_conflict"
            ? result.blocker
            : null;
          const reason =
            result.outcome === "workout_not_active"
              ? "This workout has ended. Check this set before removing it."
              : result.outcome === "retry_identity_conflict"
                ? "This set was already saved with different details."
                : result.outcome === "set_number_conflict"
                  ? "A different set is already saved in this spot."
                  : result.outcome === "set_order_conflict"
                    ? `Resolve ${result.blocker.label} first. Your later attempt is still saved on this device.`
                  : result.outcome === "stale_occurrence"
                    ? "This set changed after it was opened. Refresh the workout and review this retained attempt."
                  : result.outcome === "equipment_selection_required"
                    ? "Choose the equipment you're using before saving this set."
                  : result.outcome === "equipment_selection_conflict"
                    ? "The equipment changed while this set was waiting. Check the set and try again."
                  : result.outcome === "invalid_observed_completion"
                    ? "This set's time falls outside the workout. Check it and try again."
                  : result.outcome === "performed_evidence_conflict"
                    ? result.reason === "exercise_changed"
                      ? "The performed exercise changed while this set was waiting. Refresh and review it before trying again."
                      : result.reason === "metric_changed"
                        ? "How this exercise is measured changed while the set was waiting. Refresh and review it before trying again."
                        : "The performed exercise meaning changed while this set was waiting. Refresh and review it before trying again."
                  : result.outcome === "unsupported_set_shape"
                    ? result.reason === "unsupported_metric"
                      ? "This observation belongs in the independent activity flow, not a workout set."
                      : result.reason === "metric_semantics_conflict"
                        ? "Repbook cannot represent every applicable value for this exercise yet. Nothing partial was saved."
                      : result.reason === "assisted_reps_requires_numeric_assistance"
                        ? "Enter the amount of assistance, or add it as a note instead."
                      : result.reason === "reps_cannot_include_load"
                          ? "This version tracks reps only. Remove the weight or choose the weighted version."
                          : result.reason === "duration_requires_time"
                            ? "Enter the performed duration for this set."
                            : result.reason === "distance_duration_requires_distance"
                              ? "Enter the performed distance for this set."
                              : result.reason === "measurement_shape_conflict"
                                ? "These performed values contradict the exercise measurement. Review the set and try again."
                                : "Enter a weight for this set, or choose the bodyweight version."
                  : result.outcome === "not_found"
                    ? "We couldn't find this exercise in the workout."
                    : "We couldn't save these set details. Check them and try again.";
          recordWorkoutSetNeedsAttentionUnlocked(
            entry.clientKey,
            reason,
            orderBlocker,
            result.outcome === "stale_occurrence" ? "stale_occurrence" : null,
          );
          publishWorkoutSetOutboxEvent({
            type: "failed",
            clientKey: entry.clientKey,
            sessionId: entry.sessionId,
            blocker: orderBlocker,
          });
          return;
        }
        let restPersisted = true;
        if (entry.restAfterSec !== undefined) {
          if (entry.restAfterSec != null && entry.restAfterSec > 0) {
            const nextRest = createRestTimer({
              ownerId: entry.ownerId,
              sessionId: entry.sessionId,
              now: Date.now(),
              seconds: entry.restAfterSec,
              sourceSessionExerciseId: entry.sessionExerciseId,
              sourceOccurrenceId: result.occurrenceId,
              sourceCompletedSetId: result.setId,
            });
            restPersisted = nextRest != null &&
              await writeRestTimer(window.localStorage, nextRest);
          } else {
            const cleared = await clearRestTimerForIdentity(window.localStorage, {
              ownerId: entry.ownerId,
              sessionId: entry.sessionId,
            });
            restPersisted = cleared !== "storage_error";
          }
        }
        if (!restPersisted) {
          const marked = recordWorkoutSetTransientFailureUnlocked(
            entry.clientKey,
            "The set was saved, but this device could not retain its rest timer. It will retry safely.",
          );
          publishWorkoutSetOutboxEvent({
            type: marked.ok && marked.entry?.status !== "needs_attention" ? "saving" : "failed",
            clientKey: entry.clientKey,
            sessionId: entry.sessionId,
            ...(marked.ok && marked.entry?.status !== "needs_attention" ? { retrying: true } : {}),
          } as Parameters<typeof publishWorkoutSetOutboxEvent>[0]);
          return;
        }
        const removed = removeWorkoutSetUnlocked(entry.clientKey);
        if (!removed.ok) {
          recordWorkoutSetNeedsAttentionUnlocked(entry.clientKey, removed.reason);
          return;
        }
        for (const blockedEntry of getWorkoutSetOutboxSnapshot().entries) {
          if (blockedEntry.orderBlocker?.occurrenceId !== result.occurrenceId) {
            continue;
          }
          releaseWorkoutSetOrderBlockerOutboxEntry(
            window.localStorage,
            blockedEntry.clientKey,
            result.occurrenceId,
          );
        }
        publishWorkoutSetOutboxEvent({
          type: "saved",
          clientKey: entry.clientKey,
          sessionId: entry.sessionId,
          setId: result.setId,
          occurrenceId: result.occurrenceId,
          occurrenceRevision: result.occurrenceRevision,
          entry,
        });
      } catch (error) {
        const deploymentMismatch = reportDeploymentMismatch(error);
        const marked = recordWorkoutSetTransientFailureUnlocked(
          entry.clientKey,
          deploymentMismatch ? UPDATED_SET_FAILURE : TRANSIENT_SET_FAILURE,
        );
        if (marked.ok && marked.entry?.status !== "needs_attention") {
          publishWorkoutSetOutboxEvent({
            type: "saving",
            clientKey: entry.clientKey,
            sessionId: entry.sessionId,
            retrying: true,
          });
        } else {
          publishWorkoutSetOutboxEvent({
            type: "failed",
            clientKey: entry.clientKey,
            sessionId: entry.sessionId,
          });
        }
      }
    });
  } finally {
    activeOwners.delete(ownerId);
    if (attempted) {
      window.dispatchEvent(new Event(WORKOUT_SET_OUTBOX_CHANGE_EVENT));
    }
  }
  if (attempted && drainReady && drainDepth < 100) {
    await syncNextEntry(ownerId, true, drainDepth + 1);
  }
}

export function WorkoutSetOutboxSync({ ownerId }: { ownerId: string }) {
  const snapshot = useSyncExternalStore(
    subscribeToWorkoutSetOutbox,
    getWorkoutSetOutboxSnapshot,
    getWorkoutSetOutboxServerSnapshot
  );
  const entries = useMemo(
    () => snapshot.entries.filter((entry) => entry.ownerId === ownerId),
    [ownerId, snapshot.entries]
  );
  const equipmentSnapshot = useSyncExternalStore(
    subscribeToEquipmentSelectionOutbox,
    getEquipmentSelectionOutboxSnapshot,
    getEquipmentSelectionOutboxServerSnapshot,
  );
  const equipmentEntries = useMemo(
    () => equipmentSnapshot.entries.filter((entry) => entry.ownerId === ownerId),
    [equipmentSnapshot.entries, ownerId],
  );
  const [wakeCounter, wake] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    const onWake = () => wake();
    const onOnline = () => {
      void Promise.all([
        releaseQueuedWorkoutSetBackoff(ownerId),
        releaseQueuedEquipmentSelectionBackoff(ownerId),
      ]).then(() => wake());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ownerId]);

  useEffect(() => {
    const retryAt = [...entries, ...equipmentEntries].reduce<number | null>((earliest, entry) => {
      if (entry.status !== "queued" || !entry.nextAttemptAtISO) return earliest;
      const candidate = Date.parse(entry.nextAttemptAtISO);
      return earliest == null || candidate < earliest ? candidate : earliest;
    }, null);
    if (retryAt == null) return;
    if (retryAt <= Date.now()) return;
    const timer = window.setTimeout(
      () => wake(),
      Math.min(retryAt - Date.now(), 300_000)
    );
    return () => window.clearTimeout(timer);
  }, [entries, equipmentEntries]);

  useEffect(() => {
    void syncNextEntry(ownerId, true);
  }, [entries, equipmentEntries, ownerId, wakeCounter]);

  const hasWorkoutStatus =
    entries.length > 0 || snapshot.quarantined.length > 0 || Boolean(snapshot.error);
  const hasEquipmentStatus =
    equipmentEntries.length > 0 ||
    equipmentSnapshot.quarantined.length > 0 ||
    Boolean(equipmentSnapshot.error);

  if (!hasWorkoutStatus && !hasEquipmentStatus) return null;

  return (
    <div
      role="region"
      aria-label="Device save status"
      className="flex flex-wrap justify-end gap-2 px-4 pt-3 sm:px-6 lg:px-8"
    >
      <WorkoutSetOutboxTray
        entries={entries}
        quarantined={snapshot.quarantined}
        storageError={snapshot.error}
        onWake={wake}
      />
      <EquipmentSelectionOutboxTray
        entries={equipmentEntries}
        quarantined={equipmentSnapshot.quarantined}
        storageError={equipmentSnapshot.error}
        onWake={wake}
      />
    </div>
  );
}

export function EquipmentSelectionOutboxTray({
  entries,
  quarantined,
  storageError,
  onWake,
}: {
  entries: EquipmentSelectionOutboxEntry[];
  quarantined: QuarantinedEquipmentSelection[];
  storageError: string | null;
  onWake: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmQuarantine, setConfirmQuarantine] =
    useState<QuarantinedEquipmentSelection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const attentionCount = entries.filter(
    (entry) => entry.status === "needs_attention",
  ).length + quarantined.length;
  if (entries.length === 0 && quarantined.length === 0 && !storageError) return null;

  async function discard(entry: EquipmentSelectionOutboxEntry) {
    setActionError(null);
    const removed = await removeEquipmentSelection(entry.clientKey);
    if (!removed.ok) {
      setActionError(removed.reason);
      return;
    }
    setConfirmRemove(null);
    onWake();
  }

  async function discardQuarantine(entry: QuarantinedEquipmentSelection) {
    setActionError(null);
    const removed = await discardQuarantinedEquipmentSelection(
      entry.quarantineKey,
      entry.raw,
    );
    if (!removed.ok) {
      setActionError(removed.reason);
      return;
    }
    setConfirmQuarantine(null);
    onWake();
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirmRemove(null);
          setConfirmQuarantine(null);
          setActionError(null);
        }
      }}
      showSwipeHandle
    >
      <DrawerTrigger
        render={
          <Button
            type="button"
            size="touch"
            variant={
              attentionCount > 0 || storageError ? "destructive" : "secondary"
            }
            className="max-w-full shadow-sm"
            aria-label="Open equipment changes"
          />
        }
      >
        {attentionCount > 0 || storageError ? (
          <AlertTriangle className="size-4" />
        ) : (
          <CloudUpload className="size-4" />
        )}
        {attentionCount > 0 || storageError
          ? "Equipment changes need attention"
          : `${entries.length} setup${entries.length === 1 ? "" : "s"} saving`}
      </DrawerTrigger>
      <DrawerContent className="[--drawer-content-max-height:calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>Equipment changes</DrawerTitle>
            <DrawerDescription>
              Equipment choices stay here while they save. If a set uses a
              choice, deal with that set first so its details stay accurate.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {(storageError || actionError) && (
              <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {storageError ?? actionError}
              </p>
            )}
            {quarantined.length > 0 && (
              <section className="mt-3" aria-labelledby="unreadable-equipment-setups">
                <h3 id="unreadable-equipment-setups" className="text-sm font-medium">
                  Choices we couldn&apos;t read
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Their details stay hidden. You can&apos;t discard one while a
                  set or later choice still uses it.
                </p>
                <ol className="mt-3 flex flex-col gap-3">
                  {quarantined.map((entry, index) => (
                    <li key={entry.quarantineKey} className="rounded-xl border border-destructive/30 p-3">
                      <Badge variant="destructive">Can&apos;t read choice {index + 1}</Badge>
                      <p className="mt-2 text-sm">{entry.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {confirmQuarantine === entry ? (
                          <>
                            <Button type="button" size="sm" variant="destructive" onClick={() => void discardQuarantine(entry)}>
                              Discard saved choice
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmQuarantine(null)}>
                              Keep it
                            </Button>
                          </>
                        ) : (
                          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmQuarantine(entry)}>
                            <Trash2 className="size-3.5" /> Discard
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <ol className="mt-3 flex flex-col gap-3" aria-label="Unsaved equipment setups">
              {entries.map((entry, index) => (
                <li key={entry.clientKey} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={entry.status === "needs_attention" ? "destructive" : "secondary"}>
                      {entry.status === "needs_attention"
                        ? "Save failed"
                        : index === 0 ? "Saving" : "Waiting its turn"}
                    </Badge>
                    <span>{entry.equipmentLabel ?? "Equipment setup"}</span>
                  </div>
                  {entry.lastError && (
                    <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">{entry.lastError}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={async () => {
                      await retryEquipmentSelection(entry.clientKey);
                      onWake();
                    }}>
                      <RotateCcw className="size-3.5" /> Try now
                    </Button>
                    {confirmRemove === entry.clientKey ? (
                      <>
                        <Button type="button" size="sm" variant="destructive" onClick={() => void discard(entry)}>
                          Discard choice
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                          Keep it
                        </Button>
                      </>
                    ) : (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(entry.clientKey)}>
                        <Trash2 className="size-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
      </DrawerContent>
    </Drawer>
  );
}

export function WorkoutSetOutboxTray({
  entries,
  quarantined,
  storageError,
  onWake,
}: {
  entries: WorkoutSetOutboxEntry[];
  quarantined: QuarantinedWorkoutSetOutboxEntry[];
  storageError: string | null;
  onWake: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmQuarantine, setConfirmQuarantine] =
    useState<QuarantinedWorkoutSetOutboxEntry | null>(null);
  const [quarantineError, setQuarantineError] = useState<string | null>(null);
  const confirmQuarantineButtonRef = useRef<HTMLButtonElement>(null);
  const quarantineDiscardButtonRefs = useRef(
    new Map<string, HTMLButtonElement>()
  );
  const restoreQuarantineFocusKeyRef = useRef<string | null>(null);
  const attentionCount = entries.filter(
    (entry) => entry.status === "needs_attention"
  ).length + quarantined.length;

  useEffect(() => {
    if (confirmQuarantine) {
      confirmQuarantineButtonRef.current?.focus();
      return;
    }
    const restoreKey = restoreQuarantineFocusKeyRef.current;
    if (restoreKey) {
      quarantineDiscardButtonRefs.current.get(restoreKey)?.focus();
      restoreQuarantineFocusKeyRef.current = null;
    }
  }, [confirmQuarantine]);

  if (entries.length === 0 && quarantined.length === 0 && !storageError) return null;

  async function discard(entry: WorkoutSetOutboxEntry) {
    const removed = await removeWorkoutSet(entry.clientKey);
    if (!removed.ok) return;
    publishWorkoutSetOutboxEvent({
      type: "discarded",
      clientKey: entry.clientKey,
      sessionId: entry.sessionId,
    });
    setConfirmRemove(null);
  }

  async function discardQuarantine(entry: QuarantinedWorkoutSetOutboxEntry) {
    setQuarantineError(null);
    const removed = await discardQuarantinedWorkoutSet(
      entry.quarantineKey,
      entry.raw
    );
    if (!removed.ok) {
      setQuarantineError(removed.reason);
      return;
    }
    setConfirmQuarantine(null);
    onWake();
  }

  function keepQuarantine(entry: QuarantinedWorkoutSetOutboxEntry) {
    restoreQuarantineFocusKeyRef.current = entry.quarantineKey;
    setConfirmQuarantine(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      restoreQuarantineFocusKeyRef.current = null;
      setConfirmQuarantine(null);
      setQuarantineError(null);
    }
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} showSwipeHandle>
      <DrawerTrigger
        render={
          <Button
            type="button"
            size="touch"
            variant={
              attentionCount > 0 || storageError ? "destructive" : "secondary"
            }
            className="max-w-full shadow-sm"
            aria-label="Open sets waiting to save"
          />
        }
      >
        {attentionCount > 0 || storageError ? (
          <AlertTriangle className="size-4" />
        ) : (
          <CloudUpload className="size-4" />
        )}
        {storageError || attentionCount > 0
          ? "Sets need attention"
          : `${entries.length} set${entries.length === 1 ? "" : "s"} saving`}
      </DrawerTrigger>
      <DrawerContent className="[--drawer-content-max-height:calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>Sets waiting to save</DrawerTitle>
            <DrawerDescription>
              Sets stay here and save in order for each exercise. Save or
              discard each one before finishing your workout.
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {storageError && (
              <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {storageError}
              </p>
            )}
            {quarantineError && (
              <p role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {quarantineError}
              </p>
            )}
            {quarantined.length > 0 && (
              <section className="mt-3" aria-labelledby="unreadable-workout-sets">
                <h3 id="unreadable-workout-sets" className="text-sm font-medium">
                  Sets we couldn&apos;t read
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  We can&apos;t save these automatically, so their details stay
                  hidden. You can keep or discard them.
                </p>
                <ol className="mt-3 flex flex-col gap-3">
                  {quarantined.map((entry, index) => (
                    <li key={entry.quarantineKey} className="rounded-xl border border-destructive/30 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="destructive">Can&apos;t read</Badge>
                        <span>Saved copy {index + 1}</span>
                      </div>
                      <p className="mt-2 text-sm">{entry.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {confirmQuarantine === entry ? (
                          <>
                            <p role="alert" className="basis-full text-sm font-medium">
                              Discard this saved copy?
                            </p>
                            <Button
                              ref={confirmQuarantineButtonRef}
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() =>
                                void discardQuarantine(confirmQuarantine)
                              }
                            >
                              Discard saved copy
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => keepQuarantine(entry)}
                            >
                              Keep it
                            </Button>
                          </>
                        ) : (
                          <Button
                            ref={(node) => {
                              if (node) {
                                quarantineDiscardButtonRefs.current.set(
                                  entry.quarantineKey,
                                  node
                                );
                              } else {
                                quarantineDiscardButtonRefs.current.delete(
                                  entry.quarantineKey
                                );
                              }
                            }}
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setQuarantineError(null);
                              setConfirmQuarantine(entry);
                            }}
                          >
                            <Trash2 className="size-3.5" /> Discard
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <ol className="flex flex-col gap-3" aria-label="Unsaved workout sets">
              {entries.map((entry, index) => (
                <li key={entry.clientKey} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge
                      variant={
                        entry.status === "needs_attention"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {entry.status === "needs_attention"
                        ? "Save failed"
                        : index === 0
                          ? entry.attemptCount > 0
                            ? "Retrying"
                            : "Saving"
                          : "Waiting its turn"}
                    </Badge>
                    <span>
                      {formatRetainedWorkout(entry)} · {entry.exerciseName} · set{" "}
                      {entry.setNo}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">
                    {formatRetainedMeasurement(entry)}
                    {formatRetainedContext(entry)}
                  </p>
                  {entry.lastError && (
                    <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                      {entry.lastError}
                    </p>
                  )}
                  {entry.orderBlocker && (
                    <p className="mt-2 text-sm font-medium">
                      Required first: {entry.orderBlocker.label}. Retry unlocks
                      after that set is completed or skipped.
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href={entry.orderBlocker
                        ? `/session/${entry.sessionId}#${entry.orderBlocker.isAddedSet ? "added-set-entry" : "set-entry"}-${entry.orderBlocker.sessionExerciseId}-${entry.orderBlocker.occurrenceId}`
                        : `/session/${entry.sessionId}#exercise-${entry.sessionExerciseId}`}
                      onClick={(event) => {
                        const drawer = event.currentTarget.closest('[role="dialog"]');
                        if (
                          entry.orderBlocker &&
                          window.location.pathname === `/session/${entry.sessionId}`
                        ) {
                          event.preventDefault();
                          window.history.replaceState(
                            window.history.state,
                            "",
                            event.currentTarget.getAttribute("href") ??
                              window.location.href,
                          );
                        }
                        handleOpenChange(false);
                        if (entry.orderBlocker) {
                          let remainingFrames = 120;
                          const revealAfterDrawerCloses = () => {
                            if (drawer?.isConnected && remainingFrames > 0) {
                              remainingFrames -= 1;
                              window.requestAnimationFrame(revealAfterDrawerCloses);
                              return;
                            }
                            window.dispatchEvent(new Event("hashchange"));
                          };
                          window.requestAnimationFrame(revealAfterDrawerCloses);
                        }
                      }}
                      aria-label={entry.orderBlocker
                        ? `Go to required ${entry.orderBlocker.label}`
                        : `Return to ${entry.exerciseName} set ${entry.setNo}`}
                      className={buttonVariants({
                        size: "touch",
                        variant: "outline",
                      })}
                    >
                      <ArrowLeft className="size-3.5" /> {entry.orderBlocker
                        ? "Go to required set"
                        : "Return to exercise"}
                    </Link>
                    {!entry.orderBlocker &&
                      entry.reviewRequired !== "stale_occurrence" && (
                      <Button
                        type="button"
                        size="touch"
                        variant="outline"
                        onClick={async () => {
                          await retryWorkoutSet(entry.clientKey);
                          onWake();
                        }}
                      >
                        <RotateCcw className="size-3.5" /> Try now
                      </Button>
                    )}
                    {confirmRemove === entry.clientKey ? (
                      <Button
                        type="button"
                        size="touch"
                        variant="destructive"
                        onClick={() => void discard(entry)}
                      >
                        Discard set
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="touch"
                        variant="ghost"
                        onClick={() => setConfirmRemove(entry.clientKey)}
                      >
                        <Trash2 className="size-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                  {confirmRemove === entry.clientKey && (
                    <p className="mt-2 text-xs text-destructive">
                      If your connection dropped, try again first. Discarding
                      removes this unsaved copy from this device. If it had
                      already saved, it may show up after you refresh.
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
      </DrawerContent>
    </Drawer>
  );
}
