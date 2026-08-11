"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  confirmImport,
  discardImport,
  parseRoutineText,
  type RoutineParseResponse,
} from "@/app/actions/import";
import {
  repSpecRequiresExactPerSetSupport,
  type RepSpec,
} from "@/ai/tasks/routine-parse/schema";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { exerciseDiscoveryItemFromLibrary } from "@/lib/exercise-discovery";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
  programDayIntentSchema,
  programDayWarmupItemSchema,
  programSlotIntentSchema,
  type ProgramDayIntent,
  type ProgramDayWarmupItem,
  type ProgramSlotIntent,
} from "@/lib/program-document";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Plus,
  Trash2,
  X,
} from "lucide-react";

type ParseOk = Extract<RoutineParseResponse, { ok: true }>;
type LoadingMode = "none" | "measured" | "percentage" | "written";

type ReviewWarmupItem = ProgramDayWarmupItem & {
  included: boolean;
  loadingMode: LoadingMode;
};

type Row = {
  lineageId: string;
  rawName: string;
  exerciseId: string | null;
  sets: number | null;
  repMin: number | null;
  repMax: number | null;
  unsupportedPerSetReps: number[] | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  restSec: number | null;
  supersetKey: string | null;
  notes: string | null;
  intent: ProgramSlotIntent;
  discarded: boolean;
};

type DayState = {
  lineageId: string;
  name: string;
  warmupItems: ReviewWarmupItem[];
  intent: ProgramDayIntent;
  rows: Row[];
  intentReviewed: boolean;
};

function optionalText(value: string) {
  return value.trim() ? value.trim() : null;
}

function nullableNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function repSpecToMinMax(spec: RepSpec | null, sets: number | null) {
  if (!spec) return { min: null, max: null };
  if (spec.kind === "range") return { min: spec.min, max: spec.max };
  if (repSpecRequiresExactPerSetSupport(spec, sets)) {
    return { min: null, max: null };
  }
  return { min: Math.min(...spec.perSet), max: Math.max(...spec.perSet) };
}

function loadingMode(item: ProgramDayWarmupItem): LoadingMode {
  if (item.load != null || item.loadUnit != null) return "measured";
  if (item.loadPercent != null) return "percentage";
  if (item.loadText != null) return "written";
  return "none";
}

function orderWarmupsForExecution(
  items: ReviewWarmupItem[],
  rows: Row[],
): ReviewWarmupItem[] {
  const slotOrder = new Map(
    rows.map((row, index) => [row.lineageId, index + 1]),
  );
  return items
    .map((item, authoredIndex) => ({ item, authoredIndex }))
    .sort((left, right) => {
      const leftPosition = left.item.beforeSlotLineageId == null
        ? 0
        : (slotOrder.get(left.item.beforeSlotLineageId) ?? Number.MAX_SAFE_INTEGER);
      const rightPosition = right.item.beforeSlotLineageId == null
        ? 0
        : (slotOrder.get(right.item.beforeSlotLineageId) ?? Number.MAX_SAFE_INTEGER);
      return leftPosition - rightPosition || left.authoredIndex - right.authoredIndex;
    })
    .map(({ item }) => item);
}

function pairedRestMeaning(rows: Row[], rowIndex: number) {
  const row = rows[rowIndex];
  const groupKey = row?.supersetKey?.trim();
  if (!row || !groupKey) {
    return {
      label: "Rest after a set (seconds)",
      aria: "rest after a set",
    };
  }
  const memberIndexes = rows
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        !candidate.discarded && candidate.supersetKey?.trim() === groupKey,
    )
    .map(({ index }) => index);
  if (memberIndexes.length < 2) {
    return {
      label: "Rest for paired exercise (seconds)",
      aria: "rest for paired exercise",
    };
  }
  if (memberIndexes.at(-1) === rowIndex) {
    return {
      label: "Rest after each paired round (seconds)",
      aria: "rest after each paired round",
    };
  }
  return {
    label: "Rest before next paired exercise (seconds)",
    aria: "rest before next paired exercise",
  };
}

function suggestedSlotIntent(sets: number | null, index: number) {
  const plannedSets = sets ?? 1;
  const suggestion = createSuggestedSlotIntent(plannedSets, index);
  return programSlotIntentSchema.parse({
    ...suggestion,
    minimumDose: {
      unit: "sets",
      value: Math.min(plannedSets, suggestion.minimumDose.value),
    },
    idealDose: { unit: "sets", value: plannedSets },
    substitutionPolicy: "no_substitution",
    omissionPolicy: "never",
    calibrationEligible: false,
  });
}

function initialDays(parsed: ParseOk): DayState[] {
  const mappingByRaw = new Map(parsed.mappings.map((mapping) => [mapping.rawName, mapping]));
  return parsed.envelope.data.days.map((day) => {
    const rows = day.exercises.map((exercise, index): Row => {
      const sets =
        exercise.sets == null && exercise.reps?.kind === "perSet"
          ? exercise.reps.perSet.length
          : exercise.sets;
      const unsupportedPerSetReps =
        repSpecRequiresExactPerSetSupport(exercise.reps, exercise.sets) &&
        exercise.reps?.kind === "perSet"
          ? exercise.reps.perSet
          : null;
      const reps = repSpecToMinMax(exercise.reps, exercise.sets);
      return {
        lineageId: exercise.lineageId,
        rawName: exercise.rawName,
        exerciseId: mappingByRaw.get(exercise.rawName)?.exerciseId ?? null,
        sets,
        repMin: reps.min,
        repMax: reps.max,
        unsupportedPerSetReps,
        load: exercise.load,
        loadUnit: exercise.loadUnit,
        restSec: exercise.restSec,
        supersetKey: exercise.supersetKey,
        notes: exercise.notes,
        intent: suggestedSlotIntent(sets, index),
        discarded: false,
      };
    });
    const suggestion = createSuggestedDayIntent(
      rows.map((row) => ({
        lineageId: row.lineageId,
        sets: row.sets ?? 1,
        restSec: row.restSec ?? 90,
      })),
    );
    const warmupItems = day.warmupItems.map((item) => ({
      ...item,
      included: true,
      loadingMode: loadingMode(item),
    }));
    return {
      lineageId: day.lineageId,
      name: day.name,
      warmupItems: orderWarmupsForExecution(warmupItems, rows),
      intent: programDayIntentSchema.parse({
        ...suggestion,
        orderingPolicy: "preserve",
        pairingPolicy: "preserve",
      }),
      rows,
      intentReviewed: false,
    };
  });
}

const MATCH_BADGE: Record<string, { label: string; className: string }> = {
  exact: {
    label: "Exact match",
    className: "border-green-600/40 text-green-700 dark:text-green-400",
  },
  alias: {
    label: "Known alias",
    className: "border-green-600/40 text-green-700 dark:text-green-400",
  },
  fuzzy: {
    label: "Review match",
    className: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  },
  none: {
    label: "Needs a match",
    className: "border-destructive/40 text-destructive",
  },
};

const OUTCOMES = [
  ["strength", "Strength"],
  ["hypertrophy", "Muscle growth"],
  ["skill", "Skill practice"],
  ["conditioning", "Conditioning"],
  ["work_capacity", "Work capacity"],
  ["recovery", "Recovery"],
] as const;

const OUTCOME_LABEL = new Map<string, string>(OUTCOMES);
const PRIORITY_LABEL: Record<ProgramSlotIntent["priority"], string> = {
  must: "Essential — do not reduce",
  should: "Preferred — reduce after lower priority",
  could: "If time allows — reduce first",
};
const ROLE_LABEL: Record<ProgramSlotIntent["role"], string> = {
  anchor: "Anchor movement",
  support: "Supporting movement",
  accessory: "Accessory work",
  skill: "Skill practice",
  conditioning: "Conditioning",
  recovery: "Recovery",
};
const DAY_IDENTITY_LABEL: Record<ProgramDayIntent["identity"]["kind"], string> = {
  anchor_slots: "specific anchor exercises",
  movement_balance: "movement balance",
  muscle_emphasis: "muscle emphasis",
  skill_practice: "skill practice",
  conditioning_focus: "conditioning focus",
  recovery_session: "recovery",
};

function stripWarmupReviewState(item: ReviewWarmupItem): ProgramDayWarmupItem {
  const { included, loadingMode: _loadingMode, ...warmup } = item;
  void included;
  void _loadingMode;
  return warmup;
}

function comparableInstruction(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/^warm[ -]?up\s*:\s*/u, "")
    .replace(/[\s.!]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function RoutineImport({
  aiAvailable,
  initialParse = null,
}: {
  aiAvailable: boolean;
  initialParse?: ParseOk | null;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [clientImportId, setClientImportId] = useState(() => crypto.randomUUID());
  const [parsed, setParsed] = useState<ParseOk | null>(initialParse);
  const [programName, setProgramName] = useState(() =>
    initialParse
      ? (initialParse.envelope.data.programName ?? "Imported routine")
      : "",
  );
  const [days, setDays] = useState<DayState[]>(() =>
    initialParse ? initialDays(initialParse) : [],
  );
  const [equipmentFitReviewed, setEquipmentFitReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const libraryById = useMemo(
    () => new Map((parsed?.library ?? []).map((exercise) => [exercise.id, exercise])),
    [parsed],
  );
  const mappingByRaw = useMemo(
    () => new Map((parsed?.mappings ?? []).map((mapping) => [mapping.rawName, mapping])),
    [parsed],
  );
  const compatibleDiscoveryLibrary = useMemo(
    () =>
      (parsed?.library ?? [])
        .filter(
          (exercise) =>
            exercise.available
            && (
              exercise.equipmentFitStatus === "compatible"
              || exercise.equipmentFitStatus === "not_required"
            ),
        )
        .map((exercise) =>
          exerciseDiscoveryItemFromLibrary(exercise, {
            media: exercise.media ?? null,
          }),
        ),
    [parsed],
  );

  function handleInputChange(value: string) {
    setInput(value);
    setClientImportId(crypto.randomUUID());
    setError(null);
  }

  function handleParse() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await parseRoutineText({ text: input, clientImportId });
        if (!result.ok) {
          setError(result.reason);
          if (!result.reason.includes("still being parsed")) {
            setClientImportId(crypto.randomUUID());
          }
          return;
        }
        setParsed(result);
        setProgramName(result.envelope.data.programName ?? "Imported routine");
        setDays(initialDays(result));
        setEquipmentFitReviewed(false);
      } catch {
        setError(
          "Repbook could not finish the request. Your current Program was not changed; retry this same paste.",
        );
      }
    });
  }

  function handleDiscard() {
    const id = parsed?.importEventId;
    if (!id) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await discardImport(id);
        if (!result.ok) {
          setError("This review could not be discarded. Retry before leaving it behind.");
          return;
        }
        setParsed(null);
        setDays([]);
        setInput("");
        setProgramName("");
        setEquipmentFitReviewed(false);
        setClientImportId(crypto.randomUUID());
      } catch {
        setError("This review could not be discarded. Retry before leaving it behind.");
      }
    });
  }

  function updateDay(dayIndex: number, update: (day: DayState) => DayState) {
    setDays((current) =>
      current.map((day, index) => (index === dayIndex ? update(day) : day)),
    );
  }

  function updateRow(dayIndex: number, rowIndex: number, patch: Partial<Row>) {
    updateDay(dayIndex, (day) => ({
      ...day,
      intentReviewed: false,
      rows: day.rows.map((row, index) => {
        if (index !== rowIndex) return row;
        const next = { ...row, ...patch };
        if (Object.hasOwn(patch, "sets") && next.sets != null) {
          next.intent = {
            ...next.intent,
            minimumDose: {
              unit: "sets",
              value: Math.min(next.sets, next.intent.minimumDose.value),
            },
            idealDose: { unit: "sets", value: next.sets },
          };
        }
        return next;
      }),
    }));
    if (Object.hasOwn(patch, "exerciseId") || Object.hasOwn(patch, "discarded")) {
      setEquipmentFitReviewed(false);
    }
  }

  function updateWarmup(
    dayIndex: number,
    itemIndex: number,
    patch: Partial<ReviewWarmupItem>,
  ) {
    updateDay(dayIndex, (day) => ({
      ...day,
      warmupItems: orderWarmupsForExecution(
        day.warmupItems.map((item, index) =>
          index === itemIndex ? { ...item, ...patch } : item,
        ),
        day.rows,
      ),
    }));
  }

  function moveWarmup(dayIndex: number, itemIndex: number, direction: -1 | 1) {
    updateDay(dayIndex, (day) => {
      const currentAnchor = day.warmupItems[itemIndex]?.beforeSlotLineageId ?? null;
      const matchingIndexes = day.warmupItems
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (item.beforeSlotLineageId ?? null) === currentAnchor)
        .map(({ index }) => index);
      const currentPosition = matchingIndexes.indexOf(itemIndex);
      const target = matchingIndexes[currentPosition + direction];
      if (target === undefined) return day;
      const items = [...day.warmupItems];
      [items[itemIndex], items[target]] = [items[target]!, items[itemIndex]!];
      return { ...day, warmupItems: items };
    });
  }

  function rowBlockers(row: Row) {
    if (row.discarded) return [];
    const blockers: string[] = [];
    if (!row.exerciseId) blockers.push("choose an exercise match");
    else {
      const exercise = libraryById.get(row.exerciseId);
      if (!exercise) blockers.push("exercise is no longer available");
      else if (!exercise.available) {
        blockers.push(exercise.unavailableReason ?? "exercise is unavailable");
      }
    }
    if (row.sets == null || row.sets < 1 || row.sets > 20) {
      blockers.push("enter 1–20 sets");
    }
    if (row.unsupportedPerSetReps) {
      blockers.push("discard and rewrite different per-set rep targets as one exact target or range");
    }
    if (
      row.repMin == null ||
      row.repMax == null ||
      row.repMin < 1 ||
      row.repMax < row.repMin
    ) {
      blockers.push("enter a valid rep range");
    }
    if (row.restSec == null || row.restSec < 0 || row.restSec > 1800) {
      blockers.push("enter rest time");
    }
    if ((row.load == null) !== (row.loadUnit == null)) {
      blockers.push("pair measured load with its unit");
    }
    if (!programSlotIntentSchema.safeParse(row.intent).success) {
      blockers.push("review shortened-session choices");
    }
    if (
      row.sets != null &&
      (row.intent.minimumDose.unit !== "sets" ||
        row.intent.idealDose.unit !== "sets" ||
        row.intent.minimumDose.value > row.sets ||
        row.intent.idealDose.value !== row.sets)
    ) {
      blockers.push("minimum sets must not exceed planned sets");
    }
    return blockers;
  }

  function dayBlockers(day: DayState) {
    const blockers: string[] = [];
    const keptRows = day.rows.filter((row) => !row.discarded);
    const keptLineages = new Set(keptRows.map((row) => row.lineageId));
    if (!day.name.trim()) blockers.push("name this day");
    if (keptRows.length === 0) blockers.push("keep at least one exercise");
    if (!day.intentReviewed) blockers.push("review the day and exercise intent");
    if (!programDayIntentSchema.safeParse(day.intent).success) {
      blockers.push("fix the day planning choices");
    }
    if (
      day.intent.identity.anchorSlotLineageIds.some(
        (lineageId) => !keptLineages.has(lineageId),
      )
    ) {
      blockers.push("choose retained anchor exercises");
    }
    const pairedRows = new Map<string, Row[]>();
    for (const row of keptRows) {
      if (!row.supersetKey) continue;
      const rows = pairedRows.get(row.supersetKey) ?? [];
      rows.push(row);
      pairedRows.set(row.supersetKey, rows);
    }
    for (const [group, rows] of pairedRows) {
      if (rows.length < 2) {
        blockers.push(`clear pairing group ${group} or retain another member`);
      }
      if (new Set(rows.map((row) => row.sets)).size > 1) {
        blockers.push(`use the same planned sets in pairing group ${group} or clear it`);
      }
      if (
        new Set(rows.slice(0, -1).map((row) => row.restSec)).size > 1
      ) {
        blockers.push(`use one shared rest before the next exercise in pairing group ${group}`);
      }
    }
    const includedWarmups = day.warmupItems.filter((item) => item.included);
    for (const item of includedWarmups) {
      if (!programDayWarmupItemSchema.safeParse(stripWarmupReviewState(item)).success) {
        blockers.push(`fix warm-up: ${item.label || "unnamed step"}`);
      }
      if (item.beforeSlotLineageId && !keptLineages.has(item.beforeSlotLineageId)) {
        blockers.push(`retarget warm-up: ${item.label || "unnamed step"}`);
      }
      if (item.loadingMode === "measured" && (item.load == null || item.loadUnit == null)) {
        blockers.push(`complete the measured load for: ${item.label || "unnamed step"}`);
      }
      if (item.loadingMode === "percentage" && item.loadPercent == null) {
        blockers.push(`enter the load percentage for: ${item.label || "unnamed step"}`);
      }
      if (item.loadingMode === "written" && item.loadText == null) {
        blockers.push(`enter the loading instruction for: ${item.label || "unnamed step"}`);
      }
    }
    const labels = new Set(
      includedWarmups.map((item) => comparableInstruction(item.label)),
    );
    if (
      keptRows.some((row) =>
        (row.notes ?? "")
          .split(/[;\r\n]+/u)
          .map(comparableInstruction)
          .some((note) => note && labels.has(note)),
      )
    ) {
      blockers.push("remove a warm-up duplicated in exercise notes");
    }
    return [...new Set(blockers)];
  }

  if (!parsed) {
    return (
      <div className="rounded-xl border p-3 sm:p-4">
        <label htmlFor="routine-paste" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ClipboardPaste className="size-4" aria-hidden="true" />
          Paste your Program
        </label>
        <Textarea
          id="routine-paste"
          placeholder={
            "Program: Three-day plan\nDay 1 — Push\nWarm-up: Easy bike | load=5 minutes\nBench press 3x8 @ 135 lb, rest 2 min\nRamp-up: Empty bar | reps=10"
          }
          value={input}
          onChange={(event) => handleInputChange(event.target.value)}
          rows={10}
          maxLength={20_000}
          aria-describedby="routine-paste-help routine-paste-count"
        />
        <p id="routine-paste-help" className="mt-2 text-xs leading-5 text-muted-foreground">
          General preparation and lift ramp-ups become separate checkable steps.
          You will edit every proposed step and training choice before publication.
        </p>
        <p id="routine-paste-count" className="mt-1 text-xs text-muted-foreground">
          {input.length.toLocaleString()} / 20,000 characters
        </p>
        {!aiAvailable && (
          <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
            Canonical Program, Day, Warm-up, Ramp-up, and exercise lines still
            import without AI. Other free-form wording needs AI parsing.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          className="mt-3 min-h-11 w-full sm:w-auto"
          disabled={pending || !input.trim()}
          onClick={handleParse}
        >
          {pending ? "Parsing…" : "Parse for review"}
        </Button>
      </div>
    );
  }

  const { envelope } = parsed;
  const keptRows = days.flatMap((day) => day.rows.filter((row) => !row.discarded));
  const rowIssueCount = days
    .flatMap((day) => day.rows)
    .filter((row) => rowBlockers(row).length > 0).length;
  const dayIssues = days.flatMap((day) => dayBlockers(day));
  const canConfirm =
    !pending &&
    programName.trim().length > 0 &&
    keptRows.length > 0 &&
    rowIssueCount === 0 &&
    dayIssues.length === 0 &&
    equipmentFitReviewed;

  function handleConfirm() {
    if (!parsed || !canConfirm) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmImport({
        schemaVersion: "program-input-review/1",
        importEventId: parsed.importEventId,
        stageDigest: parsed.stageDigest,
        baseProgramVersionId: parsed.baseProgramVersionId,
        equipmentFitReviewed: true,
        equipmentFitReviewRevision: parsed.equipmentFitReviewRevision,
        programName: programName.trim(),
        days: days
          .map((day) => ({
            lineageId: day.lineageId,
            name: day.name.trim(),
            warmupItems: day.warmupItems
              .filter((item) => item.included)
              .map(stripWarmupReviewState),
            intent: day.intent,
            exercises: day.rows
              .filter((row) => !row.discarded)
              .map((row) => ({
                lineageId: row.lineageId,
                exerciseId: row.exerciseId!,
                sets: row.sets!,
                repMin: row.repMin!,
                repMax: row.repMax!,
                load: row.load,
                loadUnit: row.loadUnit,
                restSec: row.restSec!,
                supersetKey: row.supersetKey?.trim() || null,
                notes: optionalText(row.notes ?? ""),
                intent: row.intent,
              })),
          }))
          .filter((day) => day.exercises.length > 0),
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        router.push("/program");
        router.refresh();
      } catch {
        setError(
          "Repbook could not publish this reviewed Program. Nothing changed; retry this same review.",
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-primary/40 p-3 sm:p-4" aria-labelledby="routine-review-heading">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="routine-review-heading" className="font-semibold">Review the proposed Program</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Nothing is published until you accept the warm-ups, exercise matches,
              and shortened-session choices below.
            </p>
          </div>
          <Badge variant="outline">Import confidence {Math.round(envelope.confidence * 100)}%</Badge>
        </div>
        {(envelope.ambiguities.length > 0 || envelope.clarifyingQuestions.length > 0) && (
          <Alert className="mt-3">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Review uncertain details</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {envelope.ambiguities.map((ambiguity, index) => (
                  <li key={`ambiguity-${index}`}>
                    {ambiguity.issue}
                    {ambiguity.options?.length ? ` (${ambiguity.options.join(" / ")})` : ""}
                  </li>
                ))}
                {envelope.clarifyingQuestions.map((question) => <li key={question}>{question}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <label htmlFor="import-program-name" className="mt-3 block text-sm font-medium">
          Program name
        </label>
        <Input
          id="import-program-name"
          className="mt-1 min-h-11"
          value={programName}
          maxLength={120}
          onChange={(event) => setProgramName(event.target.value)}
        />
      </section>

      <Alert>
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>What a shorter-session request actually does</AlertTitle>
        <AlertDescription className="space-y-2 text-xs leading-5 sm:text-sm">
          <p>
            Repbook keeps the published exercises, order, and pairings. It never
            invents a replacement or silently omits an exercise. It can reduce
            complete sets from lower-priority, unprotected work—or complete rounds
            from a group—but never below the minimum sets you review.
          </p>
          <p>
            Essential work and exercises marked “keep all planned sets” are not
            reduced. If the protected minimum still does not fit, Repbook declines
            to build the shorter session. Goals, roles, and fatigue preference are
            saved context; they do not choose today&apos;s set reductions.
          </p>
        </AlertDescription>
      </Alert>

      {days.map((day, dayIndex) => {
        const dayProblems = dayBlockers(day);
        const keptLineages = new Set(
          day.rows.filter((row) => !row.discarded).map((row) => row.lineageId),
        );
        return (
          <section key={day.lineageId} className="rounded-xl border p-3 sm:p-4" aria-labelledby={`import-day-${day.lineageId}`}>
            <h2 id={`import-day-${day.lineageId}`} className="sr-only">Review {day.name || `day ${dayIndex + 1}`}</h2>
            <label htmlFor={`import-day-name-${day.lineageId}`} className="text-sm font-medium">
              Day {dayIndex + 1} name
            </label>
            <Input
              id={`import-day-name-${day.lineageId}`}
              className="mt-1 min-h-11 font-medium"
              value={day.name}
              maxLength={120}
              onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, name: event.target.value }))}
            />

            <section className="mt-4 rounded-xl bg-muted/30 p-3" aria-labelledby={`warmups-${day.lineageId}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 id={`warmups-${day.lineageId}`} className="font-medium">Checkable warm-up timeline</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    General preparation runs at the start. A lift ramp runs immediately
                    before its selected exercise. This order becomes the active workout order.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  aria-label={`${day.name || `Day ${dayIndex + 1}`}, add warm-up step`}
                  disabled={day.warmupItems.length >= 24}
                  onClick={() =>
                    updateDay(dayIndex, (current) => ({
                      ...current,
                      warmupItems: orderWarmupsForExecution([
                        ...current.warmupItems,
                        {
                          key: crypto.randomUUID(),
                          beforeSlotLineageId: null,
                          label: "",
                          reps: null,
                          load: null,
                          loadUnit: null,
                          loadPercent: null,
                          loadText: null,
                          notes: null,
                          included: true,
                          loadingMode: "none",
                        },
                      ], current.rows),
                    }))
                  }
                >
                  <Plus aria-hidden="true" /> Add step
                </Button>
              </div>
              {day.warmupItems.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  No warm-up step was proposed. Add one only if it belongs in this Program.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {day.warmupItems.map((item, itemIndex) => {
                    const dayLabel = day.name || `Day ${dayIndex + 1}`;
                    const itemLabel = item.label || "unnamed step";
                    const itemContext = `${dayLabel}, warm-up ${itemIndex + 1}, ${itemLabel}`;
                    return (
                    <li
                      key={item.key}
                      role="group"
                      aria-labelledby={`warmup-review-${item.key}`}
                      className={cn("rounded-xl border bg-background p-3", !item.included && "opacity-60")}
                    >
                      <span id={`warmup-review-${item.key}`} className="sr-only">{itemContext}</span>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            className="size-5"
                            aria-label={`${itemContext}, include`}
                            checked={item.included}
                            onChange={(event) => updateWarmup(dayIndex, itemIndex, { included: event.target.checked })}
                          />
                          Include step {itemIndex + 1}
                        </label>
                        <div className="flex gap-2" aria-label={`Reorder or remove ${itemContext}`}>
                          <Button type="button" size="icon" variant="outline" className="size-11" aria-label={`${itemContext}, move earlier at this point`} disabled={!day.warmupItems.slice(0, itemIndex).some((candidate) => (candidate.beforeSlotLineageId ?? null) === (item.beforeSlotLineageId ?? null))} onClick={() => moveWarmup(dayIndex, itemIndex, -1)}><ArrowUp /></Button>
                          <Button type="button" size="icon" variant="outline" className="size-11" aria-label={`${itemContext}, move later at this point`} disabled={!day.warmupItems.slice(itemIndex + 1).some((candidate) => (candidate.beforeSlotLineageId ?? null) === (item.beforeSlotLineageId ?? null))} onClick={() => moveWarmup(dayIndex, itemIndex, 1)}><ArrowDown /></Button>
                          <Button type="button" size="icon" variant="destructive" className="size-11" aria-label={`${itemContext}, remove`} onClick={() => updateDay(dayIndex, (current) => ({ ...current, warmupItems: current.warmupItems.filter((_, index) => index !== itemIndex) }))}><Trash2 /></Button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="text-xs font-medium">
                          Instruction
                          <Input aria-label={`${itemContext}, instruction`} className="mt-1 min-h-11" value={item.label} maxLength={120} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { label: event.target.value })} />
                        </label>
                        <label className="text-xs font-medium">
                          When it happens
                          <select aria-label={`${itemContext}, when it happens`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={item.beforeSlotLineageId ?? ""} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { beforeSlotLineageId: event.target.value || null })}>
                            <option value="">At the start of the workout</option>
                            {day.rows.map((row) => <option key={row.lineageId} value={row.lineageId}>Before {row.rawName}{row.discarded ? " (exercise removed)" : ""}</option>)}
                          </select>
                        </label>
                        <label className="text-xs font-medium">
                          Repetitions (if written)
                          <Input aria-label={`${itemContext}, repetitions`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={0} max={1000} value={item.reps ?? ""} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { reps: nullableNumber(event.target.value) })} />
                        </label>
                        <label className="text-xs font-medium">
                          Loading method
                          <select aria-label={`${itemContext}, loading method`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={item.loadingMode} disabled={!item.included} onChange={(event) => {
                            const nextMode = event.target.value as LoadingMode;
                            updateWarmup(dayIndex, itemIndex, {
                              loadingMode: nextMode,
                              load: nextMode === "measured" ? item.load : null,
                              loadUnit: nextMode === "measured" ? item.loadUnit : null,
                              loadPercent: nextMode === "percentage" ? item.loadPercent : null,
                              loadText: nextMode === "written" ? item.loadText : null,
                            });
                          }}>
                            <option value="none">Not stated</option>
                            <option value="measured">Measured load</option>
                            <option value="percentage">Percentage of working load</option>
                            <option value="written">Written loading instruction</option>
                          </select>
                        </label>
                      </div>
                      {item.loadingMode === "measured" && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="text-xs font-medium">Load<Input aria-label={`${itemContext}, load`} className="mt-1 min-h-11" type="number" inputMode="decimal" min={0} value={item.load ?? ""} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { load: nullableNumber(event.target.value) })} /></label>
                          <label className="text-xs font-medium">Unit<select aria-label={`${itemContext}, load unit`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={item.loadUnit ?? ""} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { loadUnit: (event.target.value || null) as "lb" | "kg" | null })}><option value="">Choose unit</option><option value="lb">lb</option><option value="kg">kg</option></select></label>
                        </div>
                      )}
                      {item.loadingMode === "percentage" && (
                        <label className="mt-3 block text-xs font-medium">Percentage of working load<Input aria-label={`${itemContext}, percentage of working load`} className="mt-1 min-h-11" type="number" inputMode="decimal" min={0} max={500} value={item.loadPercent ?? ""} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { loadPercent: nullableNumber(event.target.value) })} /></label>
                      )}
                      {item.loadingMode === "written" && (
                        <label className="mt-3 block text-xs font-medium">Written loading instruction<Input aria-label={`${itemContext}, written loading instruction`} className="mt-1 min-h-11" value={item.loadText ?? ""} maxLength={160} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { loadText: optionalText(event.target.value) })} /></label>
                      )}
                      <label className="mt-3 block text-xs font-medium">Notes (optional)<Textarea aria-label={`${itemContext}, notes`} className="mt-1" rows={2} value={item.notes ?? ""} maxLength={500} disabled={!item.included} onChange={(event) => updateWarmup(dayIndex, itemIndex, { notes: optionalText(event.target.value) })} /></label>
                      {item.included && item.beforeSlotLineageId && !keptLineages.has(item.beforeSlotLineageId) && <p role="alert" className="mt-2 text-xs text-destructive">Retarget, exclude, or remove this ramp because its exercise is no longer retained.</p>}
                    </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <p className="mt-4 rounded-lg border bg-background p-3 text-sm leading-6">
              <span className="font-medium">Day plan to review:</span>{" "}
              {OUTCOME_LABEL.get(day.intent.primaryOutcome) ?? day.intent.primaryOutcome}; usually{" "}
              {day.intent.targetDuration.minMinutes}–{day.intent.targetDuration.maxMinutes} minutes;
              shortest useful session {day.intent.minimumUsefulDurationMinutes} minutes; defined by{" "}
              {DAY_IDENTITY_LABEL[day.intent.identity.kind]}; fatigue preference {day.intent.fatigueTolerance}.
              {day.intent.secondaryOutcomes.length > 0
                ? ` Other goals: ${day.intent.secondaryOutcomes.map((outcome) => OUTCOME_LABEL.get(outcome) ?? outcome).join(", ")}.`
                : " No other goals proposed."}
            </p>

            <details className="mt-4 rounded-xl border p-3">
              <summary className="min-h-11 cursor-pointer font-medium">
                Review day planning choices
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">Starting values come only from the pasted rows. Open and adjust them; they are not based on your History or goals.</span>
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium">Main goal<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, main goal`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={day.intent.primaryOutcome} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, primaryOutcome: event.target.value as ProgramDayIntent["primaryOutcome"], secondaryOutcomes: current.intent.secondaryOutcomes.filter((outcome) => outcome !== event.target.value) } }))}>{OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="text-xs font-medium">What defines this day<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, what defines this day`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={day.intent.identity.kind} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, identity: { ...current.intent.identity, kind: event.target.value as ProgramDayIntent["identity"]["kind"], anchorSlotLineageIds: event.target.value === "anchor_slots" && current.intent.identity.anchorSlotLineageIds.length === 0 ? [current.rows.find((row) => !row.discarded)?.lineageId].filter((value): value is string => Boolean(value)) : current.intent.identity.anchorSlotLineageIds } } }))}><option value="anchor_slots">Specific anchor exercises</option><option value="movement_balance">Movement balance</option><option value="muscle_emphasis">Muscle emphasis</option><option value="skill_practice">Skill practice</option><option value="conditioning_focus">Conditioning focus</option><option value="recovery_session">Recovery session</option></select></label>
                <label className="text-xs font-medium">Usual time — minimum minutes<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, usual time minimum minutes`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={5} max={600} value={day.intent.targetDuration.minMinutes} onChange={(event) => { const value = Math.max(5, Math.min(600, Math.trunc(Number(event.target.value) || 5))); updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, targetDuration: { minMinutes: value, maxMinutes: Math.max(value, current.intent.targetDuration.maxMinutes) } } })); }} /></label>
                <label className="text-xs font-medium">Usual time — maximum minutes<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, usual time maximum minutes`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={5} max={600} value={day.intent.targetDuration.maxMinutes} onChange={(event) => { const value = Math.max(day.intent.targetDuration.minMinutes, Math.min(600, Math.trunc(Number(event.target.value) || day.intent.targetDuration.minMinutes))); updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, targetDuration: { ...current.intent.targetDuration, maxMinutes: value }, minimumUsefulDurationMinutes: Math.min(value, current.intent.minimumUsefulDurationMinutes) } })); }} /></label>
                <label className="text-xs font-medium">Shortest useful session<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, shortest useful session`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={5} max={day.intent.targetDuration.maxMinutes} value={day.intent.minimumUsefulDurationMinutes} onChange={(event) => { const value = Math.max(5, Math.min(day.intent.targetDuration.maxMinutes, Math.trunc(Number(event.target.value) || 5))); updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, minimumUsefulDurationMinutes: value } })); }} /></label>
                <label className="text-xs font-medium">Fatigue preference (saved context)<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, fatigue preference`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={day.intent.fatigueTolerance} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, fatigueTolerance: event.target.value as ProgramDayIntent["fatigueTolerance"] } }))}><option value="low">Low</option><option value="normal">Usual</option><option value="high">High</option></select></label>
              </div>
              <fieldset className="mt-3 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">Other goals (saved context)</legend>
                <div className="mt-2 flex flex-wrap gap-3">
                  {OUTCOMES.filter(([value]) => value !== day.intent.primaryOutcome).map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-2 text-sm"><input aria-label={`${day.name || `Day ${dayIndex + 1}`}, other goal ${label}`} type="checkbox" className="size-5" checked={day.intent.secondaryOutcomes.includes(value)} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, secondaryOutcomes: event.target.checked ? [...current.intent.secondaryOutcomes, value].slice(0, 3) : current.intent.secondaryOutcomes.filter((outcome) => outcome !== value) } }))} />{label}</label>)}
                </div>
              </fieldset>
              {day.intent.identity.kind === "anchor_slots" && (
                <fieldset className="mt-3 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">Exercises that define this day</legend>
                  <div className="mt-2 space-y-1">
                    {day.rows.map((row) => <label key={row.lineageId} className="flex min-h-11 items-center gap-2 text-sm"><input aria-label={`${day.name || `Day ${dayIndex + 1}`}, day-defining exercise ${row.rawName}`} type="checkbox" className="size-5" disabled={row.discarded} checked={day.intent.identity.anchorSlotLineageIds.includes(row.lineageId)} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, identity: { ...current.intent.identity, anchorSlotLineageIds: event.target.checked ? [...current.intent.identity.anchorSlotLineageIds, row.lineageId] : current.intent.identity.anchorSlotLineageIds.filter((lineageId) => lineageId !== row.lineageId) } } }))} />{row.rawName}{row.discarded ? " (removed)" : ""}</label>)}
                  </div>
                </fieldset>
              )}
              <label className="mt-3 block text-xs font-medium">Planning note (optional)<Textarea aria-label={`${day.name || `Day ${dayIndex + 1}`}, planning note`} className="mt-1" rows={2} value={day.intent.note ?? ""} maxLength={1000} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: false, intent: { ...current.intent, note: optionalText(event.target.value) } }))} /></label>
              <p className="mt-3 rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">Current behavior always preserves exercise order and existing pairings. Automatic replacement and omission are off.</p>
            </details>

            <div className="mt-4 space-y-3">
              <div>
                <h3 className="font-medium">Exercises</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Review the exact catalog match, prescription, notes, priority, and minimum sets. Lift ramps are shown in the timeline above, not duplicated in notes.</p>
              </div>
              {day.rows.map((row, rowIndex) => {
                const mapping = mappingByRaw.get(row.rawName);
                const chosen = row.exerciseId ? libraryById.get(row.exerciseId) : null;
                const matchType = row.exerciseId == null ? "none" : row.exerciseId === mapping?.exerciseId ? (mapping?.matchType ?? "fuzzy") : "fuzzy";
                const badge = MATCH_BADGE[matchType];
                const blockers = rowBlockers(row);
                const restMeaning = pairedRestMeaning(day.rows, rowIndex);
                return (
                  <article key={row.lineageId} className={cn("rounded-xl border p-3", row.discarded && "opacity-60", !row.discarded && blockers.length > 0 && "border-destructive/60")} aria-labelledby={`import-row-${row.lineageId}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 id={`import-row-${row.lineageId}`} className="break-words font-medium">{row.rawName}</h4>
                        <div className="mt-1 flex flex-wrap gap-2"><Badge variant="outline" className={badge.className}>{badge.label}</Badge>{row.supersetKey && <Badge variant="outline">Paired group {row.supersetKey}</Badge>}</div>
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={row.discarded ? `${day.name || `Day ${dayIndex + 1}`}, restore ${row.rawName}` : `${day.name || `Day ${dayIndex + 1}`}, remove ${row.rawName}`} onClick={() => updateRow(dayIndex, rowIndex, { discarded: !row.discarded })}><X /></Button>
                    </div>
                    {!row.discarded && (
                      <>
                        {row.unsupportedPerSetReps && <p role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-5 text-destructive">Authored set targets: {row.unsupportedPerSetReps.join(" / ")}. Repbook cannot store different rep targets for individual sets in a Program without changing their meaning. Discard this review, rewrite the exercise as one exact target or range, and parse it again.</p>}
                        {(mapping?.candidates.length ?? 0) > 0 && (
                          <label className="mt-3 block text-xs font-medium">Suggested compatible match<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, suggested compatible match`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={row.exerciseId ?? ""} onChange={(event) => updateRow(dayIndex, rowIndex, { exerciseId: event.target.value || null })}><option value="">Choose a match</option>{mapping!.candidates.map((candidate) => { const option = libraryById.get(candidate.id); const proven = option?.equipmentFitStatus === "compatible" || option?.equipmentFitStatus === "not_required"; return <option key={candidate.id} value={candidate.id} disabled={!option?.available || !proven}>{candidate.name}{candidate.why ? ` — ${candidate.why}` : ""}{option && !option.available ? " — unavailable" : option && !proven ? " — equipment review required" : ""}</option>; })}</select></label>
                        )}
                        <div className="mt-3"><ExercisePicker items={compatibleDiscoveryLibrary} selectedId={row.exerciseId} triggerLabel={chosen ? `${day.name || `Day ${dayIndex + 1}`}: change ${chosen.name}` : `${day.name || `Day ${dayIndex + 1}`}: browse compatible exercises for ${row.rawName}`} title={`Match “${row.rawName}”`} description="Only choices with current positive exact-pair evidence, current inventory, and permitted movement constraints are offered. Repbook never substitutes one automatically." confirmLabel="Use this match" onSelect={(exercise) => updateRow(dayIndex, rowIndex, { exerciseId: exercise.id })} /></div>
                        {chosen && !chosen.available && <p role="alert" className="mt-2 flex items-start gap-2 text-xs text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{chosen.name}: {chosen.unavailableReason ?? "not available"}. Replace or remove it.</p>}
                        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <label className="text-xs font-medium">Planned sets<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, planned sets`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={1} max={20} value={row.sets ?? ""} onChange={(event) => updateRow(dayIndex, rowIndex, { sets: nullableNumber(event.target.value) })} /></label>
                          <fieldset><legend className="text-xs font-medium">Rep range</legend><div className="mt-1 grid grid-cols-2 gap-2"><Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, minimum reps`} className="min-h-11" type="number" inputMode="numeric" min={1} max={100} value={row.repMin ?? ""} onChange={(event) => updateRow(dayIndex, rowIndex, { repMin: nullableNumber(event.target.value) })} /><Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, maximum reps`} className="min-h-11" type="number" inputMode="numeric" min={1} max={100} value={row.repMax ?? ""} onChange={(event) => updateRow(dayIndex, rowIndex, { repMax: nullableNumber(event.target.value) })} /></div></fieldset>
                          <fieldset><legend className="text-xs font-medium">Planned load</legend><div className="mt-1 grid grid-cols-[minmax(0,1fr)_5rem] gap-2"><Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, planned load`} className="min-h-11" type="number" inputMode="decimal" min={0} value={row.load ?? ""} placeholder="Not set" onChange={(event) => { const load = nullableNumber(event.target.value); updateRow(dayIndex, rowIndex, { load, loadUnit: load == null ? null : row.loadUnit }); }} /><select aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, load unit`} className="h-11 rounded-lg border border-input bg-background px-2 text-sm" value={row.loadUnit ?? ""} disabled={row.load == null} onChange={(event) => updateRow(dayIndex, rowIndex, { loadUnit: (event.target.value || null) as "lb" | "kg" | null })}><option value="">Unit</option><option value="lb">lb</option><option value="kg">kg</option></select></div></fieldset>
                          <label className="text-xs font-medium">{restMeaning.label}<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, ${restMeaning.aria}`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={0} max={1800} value={row.restSec ?? ""} onChange={(event) => updateRow(dayIndex, rowIndex, { restSec: nullableNumber(event.target.value) })} /></label>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <label className="block text-xs font-medium">Pairing group (optional)<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, pairing group`} className="mt-1 min-h-11" value={row.supersetKey ?? ""} maxLength={80} placeholder="Leave blank for no pairing" onChange={(event) => updateRow(dayIndex, rowIndex, { supersetKey: optionalText(event.target.value) })} /></label>
                          <label className="block text-xs font-medium">Exercise notes (optional)<Textarea aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, exercise notes`} className="mt-1" rows={2} value={row.notes ?? ""} maxLength={2000} onChange={(event) => updateRow(dayIndex, rowIndex, { notes: optionalText(event.target.value) })} /></label>
                        </div>
                        {row.supersetKey && <p className="mt-2 text-xs leading-5 text-muted-foreground">Paired timing follows exercise order: non-final members rest before the next paired exercise; the final member rests after the full round. Every non-final member in a group must use the same rest time.</p>}
                        <p className="mt-3 rounded-lg border bg-background p-3 text-sm leading-6">
                          <span className="font-medium">Shorter-session choice to review:</span>{" "}
                          {PRIORITY_LABEL[row.intent.priority]}; minimum {row.intent.minimumDose.value} of {row.sets ?? "?"} planned sets;
                          {row.intent.protectedOrder ? " keep all planned sets." : " set reduction is allowed to the reviewed minimum."}{" "}
                          Saved role: {ROLE_LABEL[row.intent.role]}.
                        </p>
                        <details className="mt-3 rounded-lg border bg-muted/20 p-3">
                          <summary className="min-h-11 cursor-pointer text-sm font-medium">Shortened-session choices for {row.rawName}</summary>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <label className="text-xs font-medium">Training role (saved context)<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, training role`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={row.intent.role} onChange={(event) => updateRow(dayIndex, rowIndex, { intent: { ...row.intent, role: event.target.value as ProgramSlotIntent["role"] } })}><option value="anchor">Anchor movement</option><option value="support">Supporting movement</option><option value="accessory">Accessory work</option><option value="skill">Skill practice</option><option value="conditioning">Conditioning</option><option value="recovery">Recovery</option></select></label>
                            <label className="text-xs font-medium">Set-reduction priority<select aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, set-reduction priority`} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={row.intent.priority} onChange={(event) => updateRow(dayIndex, rowIndex, { intent: { ...row.intent, priority: event.target.value as ProgramSlotIntent["priority"] } })}><option value="must">Essential — do not reduce</option><option value="should">Preferred — reduce after lower priority</option><option value="could">If time allows — reduce first</option></select></label>
                            <label className="text-xs font-medium">Minimum useful sets<Input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, minimum useful sets`} className="mt-1 min-h-11" type="number" inputMode="numeric" min={1} max={row.sets ?? 20} value={row.intent.minimumDose.value} onChange={(event) => { const value = Math.max(1, Math.min(row.sets ?? 20, Math.trunc(Number(event.target.value) || 1))); updateRow(dayIndex, rowIndex, { intent: { ...row.intent, minimumDose: { unit: "sets", value }, idealDose: { unit: "sets", value: row.sets ?? value } } }); }} /></label>
                            <div className="rounded-lg border bg-background p-3 text-xs leading-5"><span className="font-medium">Full session:</span> {row.sets ?? "?"} planned sets. Repbook never adds sets above this number.</div>
                          </div>
                          <label className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border bg-background px-3 text-sm"><input aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, keep all planned sets in shorter sessions`} type="checkbox" className="size-5" checked={row.intent.protectedOrder} onChange={(event) => updateRow(dayIndex, rowIndex, { intent: { ...row.intent, protectedOrder: event.target.checked } })} />Keep all planned sets in shorter sessions</label>
                          <label className="mt-3 block text-xs font-medium">Planning note (optional)<Textarea aria-label={`${day.name || `Day ${dayIndex + 1}`}, ${row.rawName}, planning note`} className="mt-1" rows={2} value={row.intent.note ?? ""} maxLength={1000} onChange={(event) => updateRow(dayIndex, rowIndex, { intent: { ...row.intent, note: optionalText(event.target.value) } })} /></label>
                          <p className="mt-3 text-xs leading-5 text-muted-foreground">Automatic replacement: off. Automatic omission: off. Repbook keeps these choices until you review and publish a changed Program.</p>
                        </details>
                        {blockers.length > 0 && <p role="alert" className="mt-2 text-xs text-destructive">Fix: {blockers.join("; ")}.</p>}
                      </>
                    )}
                  </article>
                );
              })}
            </div>

            <label className="mt-4 flex min-h-11 items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
              <input aria-label={`${day.name || `Day ${dayIndex + 1}`}: I reviewed this day’s goal, time range, exercise priorities, and minimum sets`} type="checkbox" className="mt-0.5 size-5 shrink-0" checked={day.intentReviewed} onChange={(event) => updateDay(dayIndex, (current) => ({ ...current, intentReviewed: event.target.checked }))} />
              <span><span className="font-medium">I reviewed this day’s goal, time range, exercise priorities, and minimum sets.</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Checking this marks the displayed values as reviewed; editing them later clears this check.</span></span>
            </label>
            {dayProblems.length > 0 && <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">Day still needs: {dayProblems.join("; ")}.</p>}
          </section>
        );
      })}

      <section className="rounded-xl border p-3 sm:p-4" aria-labelledby="equipment-fit-review">
        <h2 id="equipment-fit-review" className="font-medium">Confirm exact equipment fit</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Repbook checked catalog requirements against your inventory categories and
          current movement constraints. That does not prove a specific setup works—for
          example, owning a cable station does not prove it has a usable face-pull position.
          Replace or remove any movement that does not physically fit your setup.
        </p>
        <label className="mt-3 flex min-h-11 items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={equipmentFitReviewed} onChange={(event) => setEquipmentFitReviewed(event.target.checked)} />
          <span><span className="font-medium">I confirmed every retained exercise works with my exact equipment setup.</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">This blocks the import from guessing and applies only to this publication. Repbook remembers an exact pair only when you record it in Equipment settings; this check never creates or changes that retained evidence.</span></span>
        </label>
      </section>

      {envelope.unparsed.length > 0 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Not placed in the Program: {envelope.unparsed.join(" · ")}
        </p>
      )}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 -mx-1 flex flex-col gap-2 border-t bg-background/95 p-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
        <Button className="min-h-11 flex-1 whitespace-normal" disabled={!canConfirm} onClick={handleConfirm}>
          {pending ? "Publishing…" : !programName.trim() ? "Name the Program to continue" : !equipmentFitReviewed ? "Confirm exact equipment fit to continue" : rowIssueCount > 0 || dayIssues.length > 0 ? "Finish the review to continue" : "Publish reviewed Program"}
        </Button>
        <Button variant="outline" className="min-h-11" disabled={pending} onClick={handleDiscard}>Discard staged review</Button>
      </div>
    </div>
  );
}
