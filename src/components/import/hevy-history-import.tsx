"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  FileUp,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  confirmHevyHistoryImport,
  discardHevyHistoryImport,
} from "@/app/actions/hevy-import";
import type { HistoryImportSummary } from "@/db/schema";
import type { ImportBatchArchivePreview } from "@/services/archive";
import type { LibraryExerciseOption } from "@/services/routine-import";
import type {
  HevyExerciseReview,
  StagedHevyImport,
} from "@/services/hevy-import";
import type { ConfirmHevyImportInput } from "@/services/hevy-import-persist";
import type { ExtendedExerciseCandidate } from "@/services/extended-exercise-catalog";
import { exerciseMatchesIdentityHints } from "@/services/exercise-compat";
import { searchExerciseLibrary } from "@/services/exercise-library-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ImportBatchArchiveButton } from "@/components/import/import-batch-archive-button";

type FamilyOption = {
  id: string;
  name: string;
  movementPattern: string;
  primaryMuscles: string[];
};

type BatchOption = {
  id: string;
  filename: string;
  confirmedAtISO: string;
  summary: HistoryImportSummary;
  archivePreview: ImportBatchArchivePreview | null;
};

type CustomDraft = {
  name: string;
  familyId: string;
  movementPattern: string;
  primaryMuscles: string;
  secondaryMuscles: string;
  isUnilateral: boolean;
  loadType: "barbell" | "ez_bar" | "dumbbell" | "kettlebell" | "band" | "bodyweight" | "external";
  equipment: string;
  activityClass: "strength" | "conditioning" | "mobility" | "stretch" | "activation" | "warmup";
  metricType: "weight_reps" | "reps" | "assisted_reps" | "duration" | "distance_duration" | "activity";
  loadSemantics: "total" | "per_implement" | "bodyweight" | "added_weight" | "assistance" | "machine_stack" | "resistance_band" | "none";
  promoteToMainLibrary: boolean;
};

type ResolutionState =
  | { action: "pending"; exerciseId: string | null }
  | { action: "match"; exerciseId: string }
  | { action: "create"; exercise: CustomDraft }
  | { action: "exclude"; reason: string };

const EQUIPMENT_OPTIONS = [
  "barbell", "ez_bar", "dumbbell", "kettlebell", "cable", "machine",
  "bodyweight", "bands", "trap_bar", "smith_machine", "suspension",
  "medicine_ball", "stability_ball", "foam_roller", "sled", "rowing_machine",
  "stationary_bike", "treadmill", "stair_machine", "dip_station", "box",
  "landmine", "battle_rope", "pullup_bar", "jump_rope", "elliptical", "other",
] as const;

function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function defaultLoadType(equipment: string | null): CustomDraft["loadType"] {
  if (equipment === "barbell") return "barbell";
  if (equipment === "ez_bar") return "ez_bar";
  if (equipment === "dumbbell") return "dumbbell";
  if (equipment === "kettlebell") return "kettlebell";
  if (equipment === "bands") return "band";
  if (equipment === "bodyweight" || equipment == null) return "bodyweight";
  return "external";
}

function defaultSemantics(equipment: string | null): CustomDraft["loadSemantics"] {
  if (equipment === "dumbbell" || equipment === "kettlebell") return "per_implement";
  if (equipment === "bodyweight" || equipment == null) return "bodyweight";
  if (equipment === "bands") return "resistance_band";
  if (equipment === "cable" || equipment === "machine" || equipment === "smith_machine") {
    return "machine_stack";
  }
  return "total";
}

function makeCustomDraft(review: HevyExerciseReview, families: FamilyOption[]): CustomDraft {
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const rawKey = compact(review.rawName);
  const family = families.find((item) =>
    rawKey.includes(compact(item.name))
  ) ?? families.find((item) => item.movementPattern === (review.metricTypes.includes("duration") ? "conditioning" : "core")) ?? families[0];
  const equipment = review.equipment ?? "bodyweight";
  return {
    name: review.rawName,
    familyId: family?.id ?? "",
    movementPattern: family?.movementPattern ?? "conditioning",
    primaryMuscles: family?.primaryMuscles.join(", ") ?? "full body",
    secondaryMuscles: "",
    isUnilateral: false,
    loadType: defaultLoadType(equipment),
    equipment,
    activityClass: review.metricTypes.some((metric) => metric === "duration" || metric === "distance_duration")
      ? "conditioning"
      : "strength",
    metricType: review.metricTypes[0] ?? "reps",
    loadSemantics: review.assistance === "assisted"
      ? "assistance"
      : review.assistance === "weighted"
        ? "added_weight"
        : defaultSemantics(equipment),
    promoteToMainLibrary: false,
  };
}

function initialResolutions(stage: StagedHevyImport): Map<string, ResolutionState> {
  return new Map(
    stage.exercises.map((review) => [
      review.key,
      review.previousMapping && review.suggestedExerciseId
        ? { action: "match" as const, exerciseId: review.suggestedExerciseId }
        : { action: "pending" as const, exerciseId: review.suggestedExerciseId },
    ])
  );
}

function compatibleLibrary(review: HevyExerciseReview, library: LibraryExerciseOption[]) {
  // Same predicate the server-side matcher and confirmation gate use, so the
  // dropdown can never hide an option the server would accept (or offer one
  // it would reject).
  return library.filter((exercise) =>
    exerciseMatchesIdentityHints(exercise, {
      equipment: review.equipment,
      assistance: review.assistance,
    })
  );
}

export function HevyHistoryImport({
  initialStage,
  library,
  families,
  batches,
}: {
  initialStage: StagedHevyImport | null;
  library: LibraryExerciseOption[];
  families: FamilyOption[];
  batches: BatchOption[];
}) {
  const router = useRouter();
  const [stage, setStage] = useState(initialStage);
  const [timezone, setTimezone] = useState("America/Toronto");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [resolutions, setResolutions] = useState(() =>
    initialStage ? initialResolutions(initialStage) : new Map<string, ResolutionState>()
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const resolvedCount = stage
    ? stage.exercises.filter((review) => resolutions.get(review.key)?.action !== "pending").length
    : 0;
  const safePending = stage
    ? stage.exercises.filter(
        (review) => review.safeForBulk && resolutions.get(review.key)?.action === "pending"
      )
    : [];
  const needsReview = stage
    ? stage.exercises.filter(
        (review) => resolutions.get(review.key)?.action === "pending"
      )
    : [];
  const completedReviews = stage
    ? stage.exercises.filter(
        (review) => resolutions.get(review.key)?.action !== "pending"
      )
    : [];

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("timezone", timezone);
      const response = await fetch("/api/import/hevy/stage", { method: "POST", body: form });
      const result = await response.json() as {
        ok: boolean;
        reason?: string;
        stage?: StagedHevyImport;
      };
      if (!result.ok) {
        setError(result.reason ?? "The Hevy export could not be staged.");
        return;
      }
      if (!result.stage) {
        setError("The Hevy review was created but could not be displayed.");
        return;
      }
      setStage(result.stage);
      setResolutions(initialResolutions(result.stage));
    } catch {
      setError("The Hevy export could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  function setResolution(key: string, resolution: ResolutionState) {
    setResolutions((current) => new Map(current).set(key, resolution));
    if (resolution.action === "create") {
      setShowCompleted(true);
      setExpanded(key);
    } else if (resolution.action !== "pending") {
      setExpanded((current) => current === key ? null : current);
    }
  }

  function acceptSafeMatches() {
    if (!stage) return;
    setResolutions((current) => {
      const next = new Map(current);
      for (const review of safePending) {
        if (review.suggestedExerciseId) {
          next.set(review.key, { action: "match", exerciseId: review.suggestedExerciseId });
        }
      }
      return next;
    });
    setExpanded(null);
  }

  function confirmImport() {
    if (!stage || resolvedCount !== stage.exercises.length) return;
    setError(null);
    const payload: ConfirmHevyImportInput = {
      importEventId: stage.importEventId,
      resolutions: stage.exercises.map((review) => {
        const resolution = resolutions.get(review.key)!;
        if (resolution.action === "match") {
          return { key: review.key, action: "match", exerciseId: resolution.exerciseId };
        }
        if (resolution.action === "exclude") {
          return { key: review.key, action: "exclude", reason: resolution.reason };
        }
        if (resolution.action === "create") {
          const draft = resolution.exercise;
          return {
            key: review.key,
            action: "create",
            exercise: {
              ...draft,
              primaryMuscles: draft.primaryMuscles.split(",").map((item) => item.trim()).filter(Boolean),
              secondaryMuscles: draft.secondaryMuscles.split(",").map((item) => item.trim()).filter(Boolean),
              equipment: [draft.equipment as (typeof EQUIPMENT_OPTIONS)[number]],
              movementPattern: draft.movementPattern as never,
            },
          };
        }
        throw new Error("Unresolved Hevy exercise");
      }),
    };
    startTransition(async () => {
      const result = await confirmHevyHistoryImport(payload);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push("/history?imported=1");
      router.refresh();
    });
  }

  function discardStage() {
    if (!stage) return;
    startTransition(async () => {
      const result = await discardHevyHistoryImport(stage.importEventId);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setStage(null);
      setResolutions(new Map());
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 font-medium">
            <Database className="size-4 text-primary" /> Hevy workout history
          </p>
          <p className="text-xs text-muted-foreground">
            Upload → confirm every distinct exercise → import as reversible history.
          </p>
        </div>
        <Badge variant="outline">trusted import</Badge>
      </header>

      {!stage ? (
        <div className="grid gap-2 rounded-lg bg-muted/30 p-3 sm:grid-cols-[1fr_13rem_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Hevy CSV export
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Export timezone
            <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          <Button disabled={!file || !timezone || uploading} onClick={upload}>
            <FileUp className="size-4" /> {uploading ? "Reading…" : "Review file"}
          </Button>
        </div>
      ) : (
        <>
          <ImportSummary stage={stage} resolvedCount={resolvedCount} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!safePending.length} onClick={acceptSafeMatches}>
              <ShieldCheck className="size-3.5" />
              Accept {safePending.length} safe match{safePending.length === 1 ? "" : "es"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Safe means name, equipment, assistance and metric identity agree.
            </span>
          </div>

          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium text-amber-950 dark:text-amber-100">Needs review</p>
                <p className="text-xs text-muted-foreground">
                  Only unresolved exercises appear here. Confirm, create, or explicitly exclude each one.
                </p>
              </div>
              <Badge className="bg-amber-600 text-white hover:bg-amber-600">
                {needsReview.length} remaining
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              {needsReview.map((review) => (
                <ExerciseReviewRow
                  key={review.key}
                  review={review}
                  resolution={resolutions.get(review.key) ?? { action: "pending", exerciseId: null }}
                  library={library}
                  families={families}
                  expanded={expanded === review.key}
                  onToggle={() => setExpanded(expanded === review.key ? null : review.key)}
                  onChange={(resolution) => setResolution(review.key, resolution)}
                />
              ))}
              {needsReview.length === 0 && (
                <p className="rounded-lg border border-green-600/30 bg-green-500/10 px-3 py-4 text-sm text-green-800 dark:text-green-300">
                  Every exercise has a decision. Review the completed section below or continue with the import.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-muted/20">
            <button
              className="flex w-full items-center justify-between gap-3 p-3 text-left"
              type="button"
              aria-expanded={showCompleted}
              onClick={() => setShowCompleted((current) => !current)}
            >
              <span>
                <span className="font-medium">Completed decisions</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Confirmed matches, new exercises, and exclusions are kept out of the way here.
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Badge variant="outline">{completedReviews.length}</Badge>
                {showCompleted ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </span>
            </button>
            {showCompleted && (
              <div className="flex flex-col gap-2 border-t p-3">
                {completedReviews.map((review) => (
                  <ExerciseReviewRow
                    key={review.key}
                    review={review}
                    resolution={resolutions.get(review.key) ?? { action: "pending", exerciseId: null }}
                    library={library}
                    families={families}
                    expanded={expanded === review.key}
                    onToggle={() => setExpanded(expanded === review.key ? null : review.key)}
                    onChange={(resolution) => setResolution(review.key, resolution)}
                  />
                ))}
                {completedReviews.length === 0 && (
                  <p className="text-xs text-muted-foreground">No decisions completed yet.</p>
                )}
              </div>
            )}
          </div>

          <div className="sticky bottom-2 z-10 flex flex-col gap-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center">
            <Button
              className="flex-1"
              disabled={pending || resolvedCount !== stage.exercises.length}
              onClick={confirmImport}
            >
              <Check className="size-4" />
              {pending
                ? "Importing…"
                : resolvedCount === stage.exercises.length
                  ? `Import ${stage.profile.workouts} workouts`
                  : `Resolve ${stage.exercises.length - resolvedCount} exercises`}
            </Button>
            <Button variant="outline" disabled={pending} onClick={discardStage}>
              Discard staged import
            </Button>
          </div>
        </>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {batches.length > 0 && <ImportedBatches batches={batches} />}
    </section>
  );
}

function ImportSummary({ stage, resolvedCount }: { stage: StagedHevyImport; resolvedCount: number }) {
  const summary = stage.profile;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-primary/5 p-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="workouts" value={summary.workouts} />
        <Stat label="exercises" value={summary.exerciseOccurrences} />
        <Stat label="sets" value={summary.sets} />
        <Stat label="warm-ups" value={summary.warmupSets} />
        <Stat label="supersets" value={summary.supersetGroups} />
        <Stat label="names reviewed" value={`${resolvedCount}/${summary.distinctExercises}`} />
        <Stat label="warnings" value={summary.warnings.length} tone={summary.warnings.length ? "watch" : "normal"} />
      </div>
      {summary.warnings.length > 0 && (
        <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-amber-800 dark:text-amber-300">
            Review {summary.warnings.length} preserved data-quality warning{summary.warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-muted-foreground">
            {summary.warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.sourceRow ?? index}`}>
                {warning.message}{warning.sourceRow ? ` (CSV row ${warning.sourceRow})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Stat({ label, value, tone = "normal" }: { label: string; value: string | number; tone?: "normal" | "watch" }) {
  return (
    <div>
      <p className={cn("text-lg font-semibold tabular-nums", tone === "watch" && "text-amber-700 dark:text-amber-400")}>{value}</p>
      <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function ExerciseReviewRow({
  review,
  resolution,
  library,
  families,
  expanded,
  onToggle,
  onChange,
}: {
  review: HevyExerciseReview;
  resolution: ResolutionState;
  library: LibraryExerciseOption[];
  families: FamilyOption[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (resolution: ResolutionState) => void;
}) {
  const selectedId = resolution.action === "pending" || resolution.action === "match"
    ? resolution.exerciseId
    : null;
  const selectedExercise = library.find((exercise) => exercise.id === selectedId);
  const compatibleOptions = compatibleLibrary(review, library);
  const [excludeReason, setExcludeReason] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const catalogResults = searchExerciseLibrary(catalogQuery, library);
  return (
    <article className={cn(
      "rounded-lg border",
      resolution.action === "pending" && "border-amber-500/50 bg-background",
      resolution.action === "match" && "border-green-600/40",
      resolution.action === "create" && "border-blue-600/40",
      resolution.action === "exclude" && "border-amber-600/40"
    )}>
      <button className="flex w-full items-start gap-2 p-3 text-left" onClick={onToggle}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 font-medium">
            {review.rawName}
            {review.equipment && <Badge variant="outline">{title(review.equipment)}</Badge>}
            <Badge variant="outline">{review.setCount} sets</Badge>
            <Badge variant="outline">{review.workoutCount} workouts</Badge>
            {resolution.action !== "pending" && (
              <Badge variant="outline" className="border-green-600/40 text-green-700 dark:text-green-400">
                {resolution.action === "match" ? "confirmed" : resolution.action === "create" ? "new exercise" : "excluded"}
              </Badge>
            )}
            {resolution.action === "pending" && (
              <Badge className="bg-amber-600 text-white hover:bg-amber-600">needs review</Badge>
            )}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">{review.reason}</span>
        </span>
        {expanded ? <ChevronUp className="mt-1 size-4" /> : <ChevronDown className="mt-1 size-4" />}
      </button>

      {expanded && (
        <div className="border-t p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md bg-muted/40 p-2 text-xs">
              <p className="font-medium">Source evidence</p>
              <p className="mt-1 text-muted-foreground">Metrics: {review.metricTypes.map(title).join(", ")}</p>
              <p className="text-muted-foreground">Sample weights: {review.sampleWeights.length ? `${review.sampleWeights.join(", ")} lb` : "none"}</p>
              {selectedExercise && (
                <p className="mt-1 text-muted-foreground">
                  Proposed: {selectedExercise.name} · {selectedExercise.family ?? title(selectedExercise.movementPattern)} · {title(selectedExercise.metricType)} · {selectedExercise.equipment.map(title).join(", ") || "no equipment"}
                </p>
              )}
              {review.sampleNotes.map((note) => <p key={note} className="mt-1 text-muted-foreground">“{note}”</p>)}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Search all {library.length} vetted exercises
                <Input
                  className="mt-1"
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Search by exercise, family, or equipment"
                />
              </label>
              <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                The full catalog is searchable. Different equipment or assistance variants remain visible but cannot be combined.
              </p>
              {catalogQuery.trim().length >= 2 && (
                <div className="mt-2 max-h-52 overflow-auto rounded-md border bg-background p-1">
                  {catalogResults.map((exercise) => {
                    const compatible = exerciseMatchesIdentityHints(exercise, {
                      equipment: review.equipment,
                      assistance: review.assistance,
                    });
                    return (
                      <button
                        key={exercise.id}
                        type="button"
                        disabled={!compatible}
                        className={cn(
                          "flex w-full items-start justify-between gap-2 rounded px-2 py-2 text-left text-xs",
                          compatible ? "hover:bg-muted" : "cursor-not-allowed opacity-50",
                          selectedId === exercise.id && "bg-primary/10"
                        )}
                        onClick={() => onChange({ action: "pending", exerciseId: exercise.id })}
                      >
                        <span>
                          <span className="font-medium">{exercise.name}</span>
                          <span className="mt-0.5 block text-muted-foreground">
                            {exercise.family ?? title(exercise.movementPattern)} · {exercise.equipment.map(title).join(", ") || "no equipment"}
                          </span>
                        </span>
                        <Badge variant="outline" className="shrink-0">
                          {compatible ? "can match" : "different variant"}
                        </Badge>
                      </button>
                    );
                  })}
                  {catalogResults.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">No vetted exercises match that search.</p>
                  )}
                </div>
              )}

              <label className="mt-3 block text-xs text-muted-foreground">Compatible suggestions</label>
              <select
                className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                value={selectedId ?? ""}
                onChange={(event) => onChange({ action: "pending", exerciseId: event.target.value || null })}
              >
                <option value="">Choose a genuine match…</option>
                {compatibleOptions.map((exercise) => (
                  <option key={exercise.id} value={exercise.id}>
                    {exercise.name} · {exercise.family ?? exercise.movementPattern} · {title(exercise.loadType)}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!selectedId}
                  onClick={() => selectedId && onChange({ action: "match", exerciseId: selectedId })}
                >
                  Confirm match
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChange({ action: "create", exercise: makeCustomDraft(review, families) })}
                >
                  Create genuine exercise
                </Button>
              </div>
            </div>
          </div>

          {resolution.action === "create" && (
            <CustomExerciseEditor
              review={review}
              draft={resolution.exercise}
              families={families}
              onChange={(exercise) => onChange({ action: "create", exercise })}
            />
          )}

          <div className="mt-3 flex gap-2 border-t pt-3">
            <Input
              value={excludeReason}
              onChange={(event) => setExcludeReason(event.target.value)}
              placeholder="Reason for explicitly excluding this exercise"
            />
            <Button
              variant="outline"
              disabled={excludeReason.trim().length < 3}
              onClick={() => onChange({ action: "exclude", reason: excludeReason.trim() })}
            >
              Exclude
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function CustomExerciseEditor({
  review,
  draft,
  families,
  onChange,
}: {
  review: HevyExerciseReview;
  draft: CustomDraft;
  families: FamilyOption[];
  onChange: (draft: CustomDraft) => void;
}) {
  const [query, setQuery] = useState(review.rawName);
  const [results, setResults] = useState<ExtendedExerciseCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const patch = (value: Partial<CustomDraft>) => onChange({ ...draft, ...value });

  async function search() {
    setSearching(true);
    try {
      const response = await fetch(`/api/exercises/candidates?q=${encodeURIComponent(query)}`);
      const data = await response.json() as { candidates?: ExtendedExerciseCandidate[] };
      setResults(data.candidates ?? []);
    } finally {
      setSearching(false);
    }
  }

  function applyCandidate(candidate: ExtendedExerciseCandidate) {
    const family = families.find((item) => item.movementPattern === candidate.movementPattern) ?? families[0];
    patch({
      name: candidate.name,
      familyId: family?.id ?? draft.familyId,
      movementPattern: family?.movementPattern ?? candidate.movementPattern,
      primaryMuscles: candidate.primaryMuscles.join(", ") || draft.primaryMuscles,
      secondaryMuscles: candidate.secondaryMuscles.join(", "),
      loadType: candidate.loadType as CustomDraft["loadType"],
      equipment: candidate.equipment[0] ?? "other",
      activityClass: candidate.activityClass as CustomDraft["activityClass"],
      metricType: candidate.metricType as CustomDraft["metricType"],
      loadSemantics: candidate.loadSemantics as CustomDraft["loadSemantics"],
    });
    setResults([]);
  }

  return (
    <div className="mt-3 rounded-lg border border-blue-600/30 bg-blue-500/5 p-3">
      <p className="text-sm font-medium">New exercise definition</p>
      <p className="text-xs text-muted-foreground">This definition is staged; it is created only with the final history import.</p>
      <div className="mt-2 flex gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search extended research catalog" />
        <Button size="sm" variant="outline" disabled={query.trim().length < 2 || searching} onClick={search}>
          <Search className="size-3.5" /> {searching ? "Searching…" : "Search"}
        </Button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 max-h-44 overflow-auto rounded-md border bg-background p-1">
          {results.map((candidate) => (
            <button key={candidate.sourceId} className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => applyCandidate(candidate)}>
              <span className="font-medium">{candidate.name}</span>
              <span className="ml-2 text-muted-foreground">{candidate.equipment.map(title).join(", ")}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Exercise name"><Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></Field>
        <Field label="Exercise family">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.familyId} onChange={(event) => {
            const family = families.find((item) => item.id === event.target.value);
            if (family) patch({ familyId: family.id, movementPattern: family.movementPattern, primaryMuscles: family.primaryMuscles.join(", ") });
          }}>
            {families.map((family) => <option key={family.id} value={family.id}>{family.name} · {title(family.movementPattern)}</option>)}
          </select>
        </Field>
        <Field label="Primary muscles"><Input value={draft.primaryMuscles} onChange={(event) => patch({ primaryMuscles: event.target.value })} /></Field>
        <Field label="Secondary muscles"><Input value={draft.secondaryMuscles} onChange={(event) => patch({ secondaryMuscles: event.target.value })} /></Field>
        <Field label="Equipment">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.equipment} onChange={(event) => patch({ equipment: event.target.value, loadType: defaultLoadType(event.target.value), loadSemantics: defaultSemantics(event.target.value) })}>
            {EQUIPMENT_OPTIONS.map((item) => <option key={item} value={item}>{title(item)}</option>)}
          </select>
        </Field>
        <Field label="How it is measured">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.metricType} onChange={(event) => patch({ metricType: event.target.value as CustomDraft["metricType"] })}>
            {(["weight_reps", "reps", "assisted_reps", "duration", "distance_duration", "activity"] as const).map((item) => <option key={item} value={item}>{title(item)}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isUnilateral} onChange={(event) => patch({ isUnilateral: event.target.checked })} /> Unilateral</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.promoteToMainLibrary} onChange={(event) => patch({ promoteToMainLibrary: event.target.checked })} /> Add to main library after duplicate check</label>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs text-muted-foreground">{label}{children}</label>;
}

function ImportedBatches({ batches }: { batches: BatchOption[] }) {
  return (
    <div className="border-t pt-3">
      <p className="text-sm font-medium">Imported Hevy batches</p>
      <div className="mt-2 flex flex-col gap-2">
        {batches.map((batch) => (
          <div key={batch.id} className="flex flex-col gap-2 rounded-md bg-muted/30 p-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate font-medium">{batch.filename}</p>
              <p className="text-muted-foreground">{batch.summary.workouts} workouts · {batch.summary.sets} sets · imported {new Date(batch.confirmedAtISO).toLocaleDateString()}</p>
              {batch.archivePreview && (
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  Archive scope: {batch.archivePreview.workouts} active workouts · {batch.archivePreview.sessionExerciseGroups} exercise groups · {batch.archivePreview.exerciseOccurrences} exercises · {batch.archivePreview.sessionOccurrences} planned occurrences · {batch.archivePreview.sessionOccurrenceMutations} mutation receipts · {batch.archivePreview.sets} active sets · {batch.archivePreview.reviewDecisions} reviewed source names · {batch.archivePreview.reviewedMappings} retained mappings · {batch.archivePreview.customExercises} retained custom exercises
                  {batch.archivePreview.previouslyArchivedWorkouts > 0
                    ? ` · ${batch.archivePreview.previouslyArchivedWorkouts} workouts already archived separately`
                    : ""}
                </p>
              )}
            </div>
            {batch.archivePreview && (
              <ImportBatchArchiveButton
                batchId={batch.id}
                filename={batch.filename}
                preview={batch.archivePreview}
              />
            )}
          </div>
        ))}
      </div>
      {batches.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every batch archive first creates and verifies a new encrypted off-database
          safety snapshot. The displayed scope is checked again inside the archive
          operation; if it changed, nothing is archived.
        </p>
      )}
    </div>
  );
}
