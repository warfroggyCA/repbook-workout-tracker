"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import {
  addExerciseToWorkout,
  getAddWorkoutExerciseOptions,
} from "@/app/actions/sessions";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  clearAddWorkoutExerciseDraft,
  readAddWorkoutExerciseDraft,
  writeAddWorkoutExerciseDraft,
  type AddWorkoutExerciseInput,
} from "@/lib/add-workout-exercise";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { toast } from "sonner";
import { createClientUuid } from "@/lib/client-uuid";

type AddExerciseOptions = {
  sessionRevision: number;
  items: ExerciseDiscoveryItem[];
  allowedIds: string[];
  disabledReasons: Record<string, string>;
};

type ReviewedAddition = {
  item: ExerciseDiscoveryItem;
  input: AddWorkoutExerciseInput;
};

const confirmedMutationIds = new Set<string>();

function rememberConfirmedMutation(mutationId: string) {
  if (confirmedMutationIds.size >= 100) {
    const oldest = confirmedMutationIds.values().next().value;
    if (oldest) confirmedMutationIds.delete(oldest);
  }
  confirmedMutationIds.add(mutationId);
}

export function AddWorkoutExercise({
  ownerId,
  sessionId,
}: {
  ownerId: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [options, setOptions] = useState<AddExerciseOptions | null>(null);
  const [pickerOpenToken, setPickerOpenToken] = useState(0);
  const [review, setReview] = useState<ReviewedAddition | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);

  const loadOptions = useCallback(async (clearMessage = true) => {
    setLoadingOptions(true);
    if (clearMessage) setMessage(null);
    try {
      const result = await getAddWorkoutExerciseOptions(sessionId);
      if (!result.ok) {
        setMessage(result.message);
        return null;
      }
      const next: AddExerciseOptions = result;
      setOptions(next);
      return next;
    } catch {
      setMessage(
        "The exercise library could not be loaded. Check the connection and try again.",
      );
      return null;
    } finally {
      setLoadingOptions(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let stored;
      try {
        stored = readAddWorkoutExerciseDraft(
          window.localStorage,
          ownerId,
          sessionId,
        );
      } catch {
        setStorageWarning(true);
        return;
      }
      if (!stored) return;
      if (confirmedMutationIds.has(stored.input.mutationId)) return;
      void loadOptions().then((loaded) => {
        const item = loaded?.items.find(
          (candidate) => candidate.id === stored.input.exerciseId,
        );
        if (!item) {
          try {
            clearAddWorkoutExerciseDraft(
              window.localStorage,
              ownerId,
              sessionId,
            );
          } catch {
            setStorageWarning(true);
          }
          return;
        }
        setReview({ item, input: stored.input });
        setReviewOpen(true);
        setMessage(
          "Your reviewed exercise was restored. It has not been added until the server confirms it.",
        );
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [loadOptions, ownerId, sessionId]);

  function persist(next: ReviewedAddition) {
    setReview(next);
    try {
      writeAddWorkoutExerciseDraft(
        window.localStorage,
        ownerId,
        next.input,
      );
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }

  async function openPicker() {
    const loaded = options ?? (await loadOptions());
    if (!loaded) return;
    setPickerOpenToken((token) => token + 1);
  }

  function selectExercise(item: ExerciseDiscoveryItem) {
    const sessionRevision = options?.sessionRevision;
    if (sessionRevision == null) return false;
    const next: ReviewedAddition = {
      item,
      input: {
        sessionId,
        exerciseId: item.id,
        mutationId: createClientUuid(),
        expectedSessionRevision: sessionRevision,
        initialSetCount: 1,
        insertion: "end",
      },
    };
    persist(next);
    setReviewOpen(true);
  }

  async function refreshReviewedExercise() {
    const loaded = await loadOptions(false);
    if (!loaded || !review) return;
    const item = loaded.items.find(
      (candidate) => candidate.id === review.input.exerciseId,
    );
    if (!item) return;
    persist({
      item,
      input: {
        ...review.input,
        expectedSessionRevision: loaded.sessionRevision,
      },
    });
  }

  async function submit() {
    if (!review || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await addExerciseToWorkout(review.input);
      if (!result.ok) {
        setMessage(result.message);
        if (result.code === "workout_changed") {
          await refreshReviewedExercise();
        } else if (result.code === "exercise_unavailable") {
          await refreshReviewedExercise();
        }
        return;
      }
      rememberConfirmedMutation(review.input.mutationId);
      let draftCleared = true;
      try {
        clearAddWorkoutExerciseDraft(
          window.localStorage,
          ownerId,
          sessionId,
        );
      } catch {
        draftCleared = false;
      }
      setReviewOpen(false);
      setReview(null);
      router.refresh();
      toast.success(
        `${review.item.name} added to this workout. Your Program is unchanged.`,
      );
      if (!draftCleared) {
        toast.warning(
          "The exercise was saved, but this browser could not clear the reviewed copy. An exact retry is safe.",
        );
      }
    } catch {
      setMessage(
        "The server did not confirm the addition. Your reviewed choice is still here to retry.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selectionStillAllowed =
    review != null &&
    review.item.available &&
    (options?.allowedIds.includes(review.item.id) ?? true);

  return (
    <section className="rounded-xl border border-dashed bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-medium">Add exercise</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add performed work to this workout only. Your Program is unchanged.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          disabled={loadingOptions}
          onClick={() => void openPicker()}
        >
          <Plus className="size-4" />
          {loadingOptions ? "Loading exercises…" : "Add exercise to this workout"}
        </Button>
      </div>

      {message && !reviewOpen && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {message}
        </p>
      )}

      {options && pickerOpenToken > 0 && (
        <div className="sr-only" aria-live="polite">
          Exercise library ready
        </div>
      )}
      {options && pickerOpenToken > 0 && (
        <ExercisePicker
          key={pickerOpenToken}
          items={options.items}
          allowedIds={options.allowedIds}
          disabledReasons={options.disabledReasons}
          selectedId={review?.item.id ?? null}
          triggerLabel="Choose a different exercise"
          title="Choose an exercise for this workout"
          description="Choose a supported exercise that is available with your current equipment and constraints. You will review it before anything is saved."
          confirmLabel="Review exercise"
          largeTouchTargets
          defaultOpen
          onSelect={selectExercise}
        />
      )}

      <Drawer
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!submitting) setReviewOpen(open);
        }}
      >
        <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11">
          <DrawerHeader>
            <DrawerTitle>Add exercise to this workout</DrawerTitle>
            <DrawerDescription>
              Review the workout-only exercise and initial sets. Nothing here
              edits the Program or creates a superset.
            </DrawerDescription>
          </DrawerHeader>
          {review && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-2">
              <section className="rounded-xl border bg-card p-3">
                <div className="flex items-center gap-3">
                  <ExerciseFamilyIcon
                    media={review.item.media}
                    family={review.item.family}
                    exerciseName={review.item.name}
                    movementPattern={review.item.movementPattern}
                  />
                  <div className="min-w-0">
                    <p className="font-semibold">{review.item.name}</p>
                    <Badge variant="outline" className="mt-1">
                      Added to this workout
                    </Badge>
                  </div>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  Added at the end of the workout. Exact equipment setup, when
                  required, is confirmed in the new exercise card before its
                  first set. Unknown setup is never invented.
                </p>
              </section>

              <label className="space-y-2">
                <span className="text-sm font-medium">Initial sets</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={10}
                  step={1}
                  value={review.input.initialSetCount}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isInteger(next) || next < 1 || next > 10) return;
                    persist({
                      ...review,
                      input: { ...review.input, initialSetCount: next },
                    });
                  }}
                  aria-describedby="add-exercise-set-help"
                />
                <span
                  id="add-exercise-set-help"
                  className="block text-xs text-muted-foreground"
                >
                  These are workout-only set rows with no Program target. More
                  can be added later.
                </span>
              </label>

              {!selectionStillAllowed && (
                <p role="alert" className="text-sm text-destructive">
                  This exercise is no longer available with the current
                  equipment or constraints. Choose another exercise.
                </p>
              )}
              {message && (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              )}
              {storageWarning && (
                <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
                  This browser could not retain the review for a reload. You can
                  still add it while this drawer remains open.
                </p>
              )}
            </div>
          )}
          <DrawerFooter>
            <Button
              type="button"
              disabled={!review || !selectionStillAllowed || submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Adding exercise…" : "Add exercise"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => setReviewOpen(false)}
            >
              Keep for later
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </section>
  );
}
