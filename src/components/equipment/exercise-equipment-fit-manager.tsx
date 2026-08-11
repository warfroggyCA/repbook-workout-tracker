"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import {
  removeExerciseEquipmentFitReview,
  saveExerciseEquipmentFitReview,
} from "@/app/actions/equipment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type {
  ExerciseEquipmentFitManagementDocument,
  ExerciseEquipmentFitReasonCode,
} from "@/services/exercise-equipment-fit-management";

const INCOMPATIBLE_REASONS: Array<{
  value: Exclude<ExerciseEquipmentFitReasonCode, "owner_verified">;
  label: string;
}> = [
  { value: "missing_capability", label: "Required capability is missing" },
  { value: "geometry_limit", label: "Position or geometry does not work" },
  { value: "attachment_limit", label: "Required attachment does not work" },
  { value: "range_of_motion_limit", label: "Usable range of motion is blocked" },
  { value: "space_limit", label: "Available space does not work" },
  { value: "safety_constraint", label: "Owner safety constraint" },
  { value: "other", label: "Other physical limitation" },
];

const SELECT_CLASS =
  "h-11 min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

function reasonLabel(reason: ExerciseEquipmentFitReasonCode): string {
  if (reason === "owner_verified") return "Owner verified this exact setup";
  return INCOMPATIBLE_REASONS.find((candidate) => candidate.value === reason)?.label
    ?? "Physical limitation";
}

function itemLabel(
  item: ExerciseEquipmentFitManagementDocument["equipmentOptions"][number],
): string {
  const identityHint = item.id.slice(-6);
  return `${item.label} · ${item.type} · ${identityHint}${item.available ? "" : " · retired"}`;
}

type Assertion = ExerciseEquipmentFitManagementDocument["assertions"][number];

function AssertionEditor({
  assertion,
  onSaved,
  onRemoved,
}: {
  assertion: Assertion;
  onSaved: (assertion: Assertion) => void;
  onRemoved: (assertionId: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [verdict, setVerdict] = useState(assertion.verdict);
  const [reasonCode, setReasonCode] = useState<ExerciseEquipmentFitReasonCode>(
    assertion.reasonCode,
  );
  const [reasonNote, setReasonNote] = useState(assertion.reasonNote ?? "");
  const [status, setStatus] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const retryMutationId = useRef<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const identityHint = assertion.equipmentItemId.slice(-6);

  function announce(message: string) {
    setStatus(message);
    window.setTimeout(() => statusRef.current?.focus(), 0);
  }

  function save() {
    const mutationId = retryMutationId.current ?? crypto.randomUUID();
    retryMutationId.current = mutationId;
    startTransition(async () => {
      try {
        const result = await saveExerciseEquipmentFitReview({
          mutationId,
          assertionId: assertion.id,
          exerciseId: assertion.exerciseId,
          equipmentItemId: assertion.equipmentItemId,
          verdict,
          reasonCode: verdict === "compatible" ? "owner_verified" : reasonCode,
          reasonNote: reasonNote.trim() || null,
          expectedRevision: assertion.revision,
        });
        if (!result.ok) {
          if (result.code !== "failed") retryMutationId.current = null;
          announce(result.reason);
          return;
        }
        retryMutationId.current = null;
        announce(
          verdict === "compatible"
            ? "Saved. This exact exercise and equipment pair is retained as compatible."
            : "Saved. This exact exercise and equipment pair is retained as incompatible.",
        );
        onSaved({
          ...assertion,
          verdict,
          reasonCode: verdict === "compatible" ? "owner_verified" : reasonCode,
          reasonNote: reasonNote.trim() || null,
          revision: result.revision ?? assertion.revision,
          evidenceCurrent: true,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        announce(
          "The result could not be confirmed. Try Save again; the same request will be retried safely.",
        );
      }
    });
  }

  function remove() {
    const mutationId = retryMutationId.current ?? crypto.randomUUID();
    retryMutationId.current = mutationId;
    startTransition(async () => {
      try {
        const result = await removeExerciseEquipmentFitReview({
          mutationId,
          assertionId: assertion.id,
          expectedRevision: assertion.revision,
        });
        if (!result.ok) {
          if (result.code !== "failed") retryMutationId.current = null;
          setRemoveOpen(false);
          announce(result.reason);
          return;
        }
        retryMutationId.current = null;
        setRemoveOpen(false);
        onRemoved(assertion.id);
      } catch {
        setRemoveOpen(false);
        announce(
          "The result could not be confirmed. Open Remove and try again; the same request will be retried safely.",
        );
      }
    });
  }

  return (
    <article className="min-w-0 rounded-xl border bg-background p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-medium">{assertion.exerciseName}</h3>
          <p className="break-words text-sm text-muted-foreground">
            {assertion.equipmentLabel} · {assertion.equipmentType} · {identityHint}
            {!assertion.equipmentAvailable ? " · retired" : ""}
          </p>
        </div>
        <Badge
          variant={
            !assertion.evidenceCurrent
              ? "outline"
              : assertion.verdict === "compatible"
                ? "secondary"
                : "destructive"
          }
        >
          {!assertion.evidenceCurrent
            ? "Review again"
            : assertion.verdict === "compatible"
              ? "Compatible"
              : "Incompatible"}
        </Badge>
      </div>

      {!assertion.evidenceCurrent ? (
        <p className="mt-2 rounded-lg border border-amber-600/50 bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
          The equipment or exercise requirements changed after this review. Repbook
          treats this pair as unknown until you review and save it again.
        </p>
      ) : (
        <p className="mt-2 break-words text-sm">
          {reasonLabel(assertion.reasonCode)}
          {assertion.reasonNote ? `: ${assertion.reasonNote}` : ""}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Owner review · revision {assertion.revision}
      </p>

      <details className="mt-3 rounded-lg border px-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Change this review
        </summary>
        <div className="grid gap-3 border-t py-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1 text-sm font-medium">
            Does this exact pair work?
            <select
              className={SELECT_CLASS}
              value={verdict}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value as "compatible" | "incompatible";
                if (next !== verdict) setReasonNote("");
                setVerdict(next);
                setReasonCode(next === "compatible" ? "owner_verified" : "missing_capability");
              }}
            >
              <option value="incompatible">No — it does not work</option>
              <option value="compatible">Yes — owner verified</option>
            </select>
          </label>

          {verdict === "incompatible" ? (
            <label className="grid min-w-0 gap-1 text-sm font-medium">
              Why does it not work?
              <select
                className={SELECT_CLASS}
                value={reasonCode}
                disabled={pending}
                onChange={(event) =>
                  setReasonCode(event.target.value as ExerciseEquipmentFitReasonCode)
                }
              >
                {INCOMPATIBLE_REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>{reason.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="grid min-w-0 gap-1 text-sm font-medium sm:col-span-2">
            Owner note {reasonCode === "other" ? "(required)" : "(optional)"}
            <Textarea
              className="min-h-24 text-base md:text-sm"
              value={reasonNote}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setReasonNote(event.target.value)}
              placeholder="Example: no usable pulley position for face pulls."
            />
          </label>

          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button size="touch" type="button" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save review"}
            </Button>
            <Button
              size="touch"
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => setRemoveOpen(true)}
            >
              Remove review
            </Button>
          </div>
        </div>
      </details>

      <p
        ref={statusRef}
        tabIndex={-1}
        role={status ? "status" : undefined}
        className="mt-2 break-words text-sm"
      >
        {status}
      </p>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="[&_button]:min-h-11 [&_button]:min-w-11">
          <DialogHeader>
            <DialogTitle>Remove this retained review?</DialogTitle>
            <DialogDescription>
              {assertion.exerciseName} with {assertion.equipmentLabel} will become unknown.
              Removing the review will not mark the pair compatible and will not change any
              existing Program, active workout, or History record.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" size="touch" variant="outline" />}>
              Keep review
            </DialogClose>
            <Button type="button" size="touch" variant="destructive" disabled={pending} onClick={remove}>
              {pending ? "Removing…" : "Remove review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function ExerciseEquipmentFitManager({
  document,
}: {
  document: ExerciseEquipmentFitManagementDocument;
}) {
  const [pending, startTransition] = useTransition();
  const [assertions, setAssertions] = useState(document.assertions);
  const [exerciseSearch, setExerciseSearch] = useState("");
  const [exerciseId, setExerciseId] = useState("");
  const [equipmentItemId, setEquipmentItemId] = useState("");
  const [verdict, setVerdict] = useState<"compatible" | "incompatible">("incompatible");
  const [reasonCode, setReasonCode] = useState<ExerciseEquipmentFitReasonCode>(
    "missing_capability",
  );
  const [reasonNote, setReasonNote] = useState("");
  const [status, setStatus] = useState("");
  const retryMutationId = useRef<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const actionableExerciseOptions = useMemo(() => document.exerciseOptions.filter(
    (exercise) => document.equipmentOptions.some((item) =>
      item.available
      && exercise.equipmentTypes.includes(item.type)
      && !assertions.some((assertion) =>
        assertion.exerciseId === exercise.id
        && assertion.equipmentItemId === item.id,
      ),
    ),
  ), [assertions, document.equipmentOptions, document.exerciseOptions]);
  const normalizedExerciseSearch = exerciseSearch.trim().toLocaleLowerCase();
  const matchingExerciseOptions = useMemo(
    () => normalizedExerciseSearch.length < 2
      ? []
      : actionableExerciseOptions.filter((exercise) =>
        exercise.name.toLocaleLowerCase().includes(normalizedExerciseSearch),
      ),
    [actionableExerciseOptions, normalizedExerciseSearch],
  );
  const displayedExerciseOptions = matchingExerciseOptions.slice(0, 50);
  const selectedExercise = actionableExerciseOptions.find(
    (exercise) => exercise.id === exerciseId,
  );
  const equipmentOptions = useMemo(() => {
    if (!selectedExercise) return [];
    const retainedPairs = new Set(
      assertions
        .filter((assertion) => assertion.exerciseId === selectedExercise.id)
        .map((assertion) => assertion.equipmentItemId),
    );
    return document.equipmentOptions.filter(
      (item) =>
        item.available
        && selectedExercise.equipmentTypes.includes(item.type)
        && !retainedPairs.has(item.id),
    );
  }, [assertions, document.equipmentOptions, selectedExercise]);
  const selectedEquipmentItemId = equipmentOptions.some(
    (item) => item.id === equipmentItemId,
  )
    ? equipmentItemId
    : "";

  function announce(message: string) {
    setStatus(message);
    window.setTimeout(() => statusRef.current?.focus(), 0);
  }

  function create() {
    if (!exerciseId || !selectedEquipmentItemId) {
      announce("Choose an exercise and a matching owned equipment item.");
      return;
    }
    const mutationId = retryMutationId.current ?? crypto.randomUUID();
    retryMutationId.current = mutationId;
    startTransition(async () => {
      try {
        const result = await saveExerciseEquipmentFitReview({
          mutationId,
          assertionId: null,
          exerciseId,
          equipmentItemId: selectedEquipmentItemId,
          verdict,
          reasonCode: verdict === "compatible" ? "owner_verified" : reasonCode,
          reasonNote: reasonNote.trim() || null,
          expectedRevision: null,
        });
        if (!result.ok) {
          if (result.code !== "failed") retryMutationId.current = null;
          announce(result.reason);
          return;
        }
        retryMutationId.current = null;
        const selectedItem = equipmentOptions.find(
          (item) => item.id === selectedEquipmentItemId,
        );
        const savedRevision = result.revision;
        if (!selectedExercise || !selectedItem || savedRevision == null) {
          announce("The saved review could not be displayed. Reload this page to inspect it.");
          return;
        }
        const now = new Date().toISOString();
        setAssertions((current) => [...current, {
          id: result.assertionId,
          exerciseId: selectedExercise.id,
          exerciseName: selectedExercise.name,
          equipmentItemId: selectedItem.id,
          equipmentLabel: selectedItem.label,
          equipmentType: selectedItem.type,
          equipmentAvailable: selectedItem.available,
          verdict,
          reasonCode: verdict === "compatible" ? "owner_verified" : reasonCode,
          reasonNote: reasonNote.trim() || null,
          provenance: "owner_review",
          semanticsVersion: 1,
          revision: savedRevision,
          evidenceCurrent: true,
          createdAt: now,
          updatedAt: now,
        }]);
        setEquipmentItemId("");
        setReasonNote("");
        announce(
          verdict === "compatible"
            ? "Saved. Only this exact owner-reviewed pair is retained as compatible."
            : "Saved. This exact pair is now blocked from prospective recommendations and publication.",
        );
      } catch {
        announce(
          "The result could not be confirmed. Try Save again; the same request will be retried safely.",
        );
      }
    });
  }

  return (
    <Card id="movement-compatibility">
      <CardHeader>
        <CardTitle>
          <h2>Movement compatibility</h2>
        </CardTitle>
        <CardDescription>
          Record whether one specific exercise works with one specific item you own.
          An equipment name or broad type is never proof. A pair with no retained review
          stays unknown, and a removed review becomes unknown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        <div className="rounded-xl border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Why compatible reviews matter</p>
          <p className="mt-1 text-muted-foreground">
            Repbook may offer only current, positively compatible evidence as an
            alternative. It will never substitute or omit an exercise automatically.
            These reviews affect future decisions only; existing Programs, active-session
            snapshots, completed workouts, imported History, and earlier Program versions
            remain unchanged.
          </p>
        </div>

        <fieldset className="grid min-w-0 gap-3 rounded-xl border p-3 sm:grid-cols-2">
          <legend className="px-1 font-medium">Record an exact pair</legend>
          <label className="grid min-w-0 gap-1 text-sm font-medium sm:col-span-2">
            Search exercises
            <input
              type="search"
              className={SELECT_CLASS}
              value={exerciseSearch}
              disabled={pending || actionableExerciseOptions.length === 0}
              aria-describedby="movement-compatibility-search-help movement-compatibility-search-status"
              onChange={(event) => {
                setExerciseSearch(event.target.value);
                setExerciseId("");
                setEquipmentItemId("");
              }}
              placeholder="Example: face pull"
              autoComplete="off"
            />
          </label>
          <p
            id="movement-compatibility-search-help"
            className="text-sm text-muted-foreground sm:col-span-2"
          >
            Type at least two characters. Results include only exercises with an
            available, matching item you own that has not already been reviewed.
          </p>
          <p
            id="movement-compatibility-search-status"
            className="text-sm sm:col-span-2"
            aria-live="polite"
          >
            {normalizedExerciseSearch.length < 2
              ? "No search yet."
              : matchingExerciseOptions.length === 0
                ? "No unreviewed exercise and owned-item matches."
                : matchingExerciseOptions.length > displayedExerciseOptions.length
                  ? `${matchingExerciseOptions.length} matches. Refine the search; showing the first ${displayedExerciseOptions.length}.`
                  : `${matchingExerciseOptions.length} matching ${matchingExerciseOptions.length === 1 ? "exercise" : "exercises"}.`}
          </p>
          <label className="grid min-w-0 gap-1 text-sm font-medium">
            Exercise
            <select
              className={SELECT_CLASS}
              value={exerciseId}
              disabled={pending || displayedExerciseOptions.length === 0}
              onChange={(event) => {
                setExerciseId(event.target.value);
                setEquipmentItemId("");
              }}
            >
              <option value="">Choose a matching exercise</option>
              {displayedExerciseOptions.map((exercise) => (
                <option key={exercise.id} value={exercise.id}>{exercise.name}</option>
              ))}
            </select>
          </label>

          <label className="grid min-w-0 gap-1 text-sm font-medium">
            Owned equipment item
            <select
              className={SELECT_CLASS}
              value={selectedEquipmentItemId}
              disabled={pending || equipmentOptions.length === 0}
              onChange={(event) => setEquipmentItemId(event.target.value)}
            >
              {equipmentOptions.length === 0 ? (
                <option value="">No unreviewed matching item</option>
              ) : (
                <option value="">Choose an owned item</option>
              )}
              {equipmentOptions.map((item) => (
                <option key={item.id} value={item.id}>{itemLabel(item)}</option>
              ))}
            </select>
          </label>

          <label className="grid min-w-0 gap-1 text-sm font-medium">
            Does this exact pair work?
            <select
              className={SELECT_CLASS}
              value={verdict}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value as "compatible" | "incompatible";
                if (next !== verdict) setReasonNote("");
                setVerdict(next);
                setReasonCode(next === "compatible" ? "owner_verified" : "missing_capability");
              }}
            >
              <option value="incompatible">No — it does not work</option>
              <option value="compatible">Yes — owner verified</option>
            </select>
          </label>

          {verdict === "incompatible" ? (
            <label className="grid min-w-0 gap-1 text-sm font-medium">
              Why does it not work?
              <select
                className={SELECT_CLASS}
                value={reasonCode}
                disabled={pending}
                onChange={(event) =>
                  setReasonCode(event.target.value as ExerciseEquipmentFitReasonCode)
                }
              >
                {INCOMPATIBLE_REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>{reason.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="grid min-w-0 gap-1 text-sm font-medium sm:col-span-2">
            Owner note {reasonCode === "other" ? "(required)" : "(optional)"}
            <Textarea
              className="min-h-24 text-base md:text-sm"
              value={reasonNote}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setReasonNote(event.target.value)}
              placeholder="Example: no usable pulley position for face pulls."
            />
          </label>

          <div className="sm:col-span-2">
            <Button
              size="touch"
              type="button"
              disabled={pending || !exerciseId || !selectedEquipmentItemId}
              onClick={create}
            >
              {pending ? "Saving…" : "Save retained review"}
            </Button>
          </div>
        </fieldset>

        <p
          id="movement-compatibility-status"
          ref={statusRef}
          tabIndex={-1}
          role={status ? "status" : undefined}
          className="break-words text-sm"
        >
          {status}
        </p>

        <div className="grid min-w-0 gap-3" aria-label="Retained movement compatibility reviews">
          {assertions.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              No exact pairs have been reviewed. Every exercise-and-item pair is unknown.
            </p>
          ) : (
            assertions.map((assertion) => (
              <AssertionEditor
                key={assertion.id}
                assertion={assertion}
                onSaved={(saved) => setAssertions((current) => current.map(
                  (candidate) => candidate.id === saved.id ? saved : candidate,
                ))}
                onRemoved={(assertionId) => {
                  setAssertions((current) => current.filter(
                    (candidate) => candidate.id !== assertionId,
                  ));
                  announce(
                    "Removed. This exact exercise and equipment pair is unknown again, not compatible.",
                  );
                }}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
