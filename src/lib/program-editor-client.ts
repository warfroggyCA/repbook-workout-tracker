import { z } from "zod";
import { formatRestTime } from "@/lib/rest-time";
import type { RoutineDraft } from "@/app/actions/setup";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
  legacyProgramDocumentSchema,
  programDocumentV3Schema,
  projectIntentProgramDocumentV2,
  storedProgramDocumentSchema,
  suggestProgramIntentDraft,
  upgradeStoredProgramDocumentToV3,
  type ProgramDocumentV3,
  type ProgramDocument,
  type ProgramDocumentDayV3,
  type ProgramDocumentSlotV3,
} from "@/lib/program-document";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";
import {
  programReviewSchema,
  type ProgramReview,
  type ProgramReviewChange,
} from "@/lib/program-review-contract";

export const PROGRAM_DRAFT_LOCAL_SCHEMA = "3" as const;
export const PROGRAM_DRAFT_LOCAL_PREFIX = "workout-tracker:program-draft:v1";

export type LocalProgramDraft = {
  schemaVersion: typeof PROGRAM_DRAFT_LOCAL_SCHEMA;
  ownerId: string;
  draftId: string;
  serverRevision: number;
  mutationId: string;
  document: ProgramDocumentV3;
  savedAt: string;
};

export type { ProgramReview, ProgramReviewChange };

export type ProgramHistoryEntry = {
  id: string;
  versionNo: number;
  name: string;
  activatedAt: string | null;
  source: string | null;
  summary: string | null;
  parentVersionId: string | null;
  restoredFromVersionId: string | null;
  sourceImportEventId: string | null;
  reviewHash: string | null;
  isCurrent: boolean;
};

export type ServerDraft = {
  id: string;
  revision: number;
  document: ProgramDocumentV3;
  reviewedRevision: number | null;
  reviewHash: string | null;
  reviewSummary: ProgramReview | null;
  reviewState:
    | { status: "none" }
    | { status: "current" }
    | { status: "expired"; reason: string };
  history: ProgramHistoryEntry[];
};

export async function programEditorResponseJson(response: Response) {
  const data = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const reason =
      data && typeof data === "object" && "reason" in data
        ? String((data as { reason: unknown }).reason)
        : data &&
            typeof data === "object" &&
            "errors" in data &&
            Array.isArray((data as { errors: unknown }).errors)
          ? (data as { errors: unknown[] }).errors.map(String).join(" ")
          : "The Program editor could not complete that request.";
    throw new Error(reason);
  }
  return data;
}

export function parseProgramDraftResponse(data: unknown): ServerDraft {
  if (
    !data ||
    typeof data !== "object" ||
    (data as { status?: unknown }).status !== "ok"
  ) {
    throw new Error("The saved Program draft could not be read.");
  }
  const candidate = (data as { draft?: unknown }).draft;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("The saved Program draft is missing.");
  }
  const draft = candidate as Partial<ServerDraft>;
  const stored = storedProgramDocumentSchema.safeParse(draft.document);
  if (
    typeof draft.id !== "string" ||
    !Number.isInteger(draft.revision) ||
    !stored.success
  ) {
    throw new Error("The saved Program draft is not valid.");
  }
  const reviewCandidate =
    draft.reviewSummary && typeof draft.reviewSummary === "object"
      ? programReviewSchema.safeParse(draft.reviewSummary)
      : null;
  const reviewIsCurrent =
    reviewCandidate?.success === true &&
    reviewCandidate.data.status === "publishable" &&
    draft.reviewedRevision === reviewCandidate.data.reviewedRevision &&
    draft.revision === reviewCandidate.data.reviewedRevision &&
    draft.reviewHash === reviewCandidate.data.hash;
  const suppliedReviewState =
    "reviewState" in draft ? draft.reviewState : undefined;
  const reviewState =
    suppliedReviewState &&
    typeof suppliedReviewState === "object" &&
    (suppliedReviewState as { status?: unknown }).status === "expired"
      ? {
          status: "expired" as const,
          reason:
            typeof (suppliedReviewState as { reason?: unknown }).reason ===
            "string"
              ? String(
                  (suppliedReviewState as { reason: unknown }).reason,
                )
              : "The earlier review expired because its safety checks are no longer current.",
        }
      : reviewIsCurrent
        ? ({ status: "current" } as const)
        : draft.reviewSummary != null || draft.reviewedRevision != null
          ? ({
              status: "expired",
              reason:
                "The earlier review expired because its safety checks are no longer current.",
            } as const)
          : ({ status: "none" } as const);
  return {
    id: draft.id,
    revision: draft.revision as number,
    document: upgradeStoredProgramDocumentToV3(stored.data),
    reviewedRevision: reviewIsCurrent && Number.isInteger(draft.reviewedRevision)
      ? (draft.reviewedRevision as number)
      : null,
    reviewHash: reviewIsCurrent ? reviewCandidate.data.hash : null,
    reviewSummary: reviewIsCurrent ? reviewCandidate.data : null,
    reviewState,
    history: draft.history == null ? [] : parseProgramHistory(draft.history),
  };
}

const historyEntrySchema = z.object({
  id: z.string().uuid(),
  versionNo: z.number().int().min(1),
  name: z.string().min(1),
  activatedAt: z.string().datetime().nullable(),
  source: z.string().nullable(),
  summary: z.string().nullable(),
  parentVersionId: z.string().uuid().nullable(),
  restoredFromVersionId: z.string().uuid().nullable(),
  sourceImportEventId: z.string().uuid().nullable(),
  reviewHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  isCurrent: z.boolean(),
});

export function parseProgramReviewResponse(value: unknown): ProgramReview {
  if (!value || typeof value !== "object") {
    throw new Error("Review was not returned.");
  }
  const container = value as Record<string, unknown>;
  const candidate = container.status === "reviewed" ? container.review : value;
  const parsed = programReviewSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("The review response is incomplete.");
  }
  return parsed.data;
}

export function parseProgramHistory(value: unknown): ProgramHistoryEntry[] {
  const parsed = z.array(historyEntrySchema).safeParse(value);
  if (!parsed.success) {
    throw new Error("The Program version history is incomplete.");
  }
  return parsed.data;
}

export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function gatherProgramSlots(
  slots: ProgramDocumentSlotV3[],
  selectedLineageIds: string[],
  supersetKey: string,
) {
  const selected = new Set(selectedLineageIds);
  const firstIndex = slots.findIndex((slot) => selected.has(slot.lineageId));
  if (firstIndex < 0) return slots;
  const members = slots
    .filter((slot) => selected.has(slot.lineageId))
    .map((slot, groupMemberOrderIdx) => ({
      ...slot,
      supersetKey,
      groupMemberOrderIdx,
    }));
  const remaining = slots.filter((slot) => !selected.has(slot.lineageId));
  remaining.splice(firstIndex, 0, ...members);
  return remaining;
}

export function moveProgramSlotUnit(
  slots: ProgramDocumentSlotV3[],
  lineageId: string,
  direction: -1 | 1,
) {
  const index = slots.findIndex((slot) => slot.lineageId === lineageId);
  if (index < 0) return slots;
  const key = slots[index].supersetKey;
  const unitIds = new Set(
    key
      ? slots.filter((slot) => slot.supersetKey === key).map((slot) => slot.lineageId)
      : [lineageId],
  );
  const units: ProgramDocumentSlotV3[][] = [];
  const gathered = slots.filter((slot) => unitIds.has(slot.lineageId));
  let inserted = false;
  for (const slot of slots) {
    if (unitIds.has(slot.lineageId)) {
      if (!inserted) units.push(gathered);
      inserted = true;
    } else units.push([slot]);
  }
  const unitIndex = units.findIndex((unit) => unit.some((slot) => slot.lineageId === lineageId));
  const target = unitIndex + direction;
  if (target < 0 || target >= units.length) return slots;
  return moveItem(units, unitIndex, target).flat();
}

export function moveProgramGroupMember(
  day: ProgramDocumentDayV3,
  groupKey: string,
  lineageId: string,
  direction: -1 | 1,
): ProgramDocumentDayV3 {
  const memberIndexes = day.exercises
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.supersetKey === groupKey);
  const memberIndex = memberIndexes.findIndex(
    ({ slot }) => slot.lineageId === lineageId,
  );
  const targetIndex = memberIndex + direction;
  if (memberIndex < 0 || targetIndex < 0 || targetIndex >= memberIndexes.length) {
    return day;
  }
  const members = moveItem(
    memberIndexes.map(({ slot }) => slot),
    memberIndex,
    targetIndex,
  );
  let nextMember = 0;
  return normalizeDaySupersets({
    ...day,
    exercises: day.exercises.map((slot) =>
      slot.supersetKey === groupKey ? members[nextMember++]! : slot,
    ),
  });
}

export function resizeSetNotes(notes: Array<string | null>, sets: number) {
  return Array.from({ length: sets }, (_, index) => notes[index] ?? null);
}

export function createDefaultProgramSlot(
  exerciseId: string,
  lineageId: string,
  index = 1,
): ProgramDocumentSlotV3 {
  return {
    lineageId,
    exerciseId,
    sets: 3,
    repMin: 8,
    repMax: 12,
    targetLoad: null,
    targetLoadUnit: null,
    progressionRuleId: "double_progression",
    restSec: 90,
    supersetKey: null,
    groupMemberOrderIdx: null,
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [null, null, null],
    intent: createSuggestedSlotIntent(3, index),
  };
}

export function programEditorSafeFilePart(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "program"
  );
}

export function updateProgramDocumentDay(
  document: ProgramDocumentV3,
  dayIndex: number,
  updater: (day: ProgramDocumentDayV3) => ProgramDocumentDayV3,
) {
  return {
    ...document,
    days: document.days.map((day, index) =>
      index === dayIndex ? normalizeDaySupersets(updater(day)) : day,
    ),
  };
}

export function addProgramExerciseToDay(
  document: ProgramDocumentV3,
  dayIndex: number,
  exerciseId: string,
  lineageId: string,
) {
  return updateProgramDocumentDay(document, dayIndex, (day) => ({
    ...day,
    exercises: [
      ...day.exercises,
      createDefaultProgramSlot(exerciseId, lineageId),
    ],
  }));
}

export function appendProgramDocumentDay(
  document: ProgramDocumentV3,
  exerciseId: string,
  dayLineageId: string,
  slotLineageId: string,
) {
  // A new day must carry structured intent from the moment it exists; review
  // and Preflight both read it, and the document schema requires it.
  const exercises = [createDefaultProgramSlot(exerciseId, slotLineageId)];
  return {
    ...document,
    days: [
      ...document.days,
      {
        lineageId: dayLineageId,
        name: `Day ${document.days.length + 1}`,
        notes: null,
        warmupNotes: null,
        warmupItems: [],
        intent: createSuggestedDayIntent(exercises),
        supersets: [],
        exercises,
      },
    ],
  };
}

export function moveProgramSlotToDay(
  document: ProgramDocumentV3,
  sourceDay: number,
  slotIndex: number,
  targetDay: number,
) {
  const slot = {
    ...document.days[sourceDay].exercises[slotIndex],
    supersetKey: null,
    groupMemberOrderIdx: null,
  };
  return {
    ...document,
    days: document.days.map((day, index) => {
      if (index === sourceDay) {
        return normalizeDaySupersets({
          ...day,
          exercises: day.exercises.filter(
            (_, itemIndex) => itemIndex !== slotIndex,
          ),
        });
      }
      if (index === targetDay) {
        return { ...day, exercises: [...day.exercises, slot] };
      }
      return day;
    }),
  };
}

export function programDocumentFromRoutineDraft(
  current: ProgramDocument | ProgramDocumentV3,
  routine: RoutineDraft,
  createId: () => string = () => crypto.randomUUID(),
): ProgramDocument {
  const currentV3 = upgradeStoredProgramDocumentToV3(current);
  const rebuilt: ProgramDocumentV3 = {
    ...currentV3,
    days: routine.days.map((day) => {
      const groupCounts = new Map<string, number>();
      for (const exercise of day.exercises) {
        if (exercise.supersetGroup) {
          groupCounts.set(
            exercise.supersetGroup,
            (groupCounts.get(exercise.supersetGroup) ?? 0) + 1,
          );
        }
      }
      const groupKeys = new Map<string, string>();
      for (const [name, count] of groupCounts) {
        if (count >= 2) groupKeys.set(name, createId());
      }
      const exercises = day.exercises.map((exercise, index) => ({
        lineageId: createId(),
        exerciseId: exercise.exerciseId,
        sets: exercise.sets,
        repMin: exercise.repMin,
        repMax: exercise.repMax,
        targetLoad: exercise.targetLoad,
        targetLoadUnit: exercise.targetLoadUnit,
        progressionRuleId: "double_progression",
        restSec: exercise.restSec,
        supersetKey: exercise.supersetGroup
          ? groupKeys.get(exercise.supersetGroup) ?? null
          : null,
        groupMemberOrderIdx: exercise.supersetGroup
          ? day.exercises
              .slice(0, index)
              .filter((candidate) => candidate.supersetGroup === exercise.supersetGroup)
              .length
          : null,
        notes: exercise.notes,
        warmupNotes: exercise.warmup?.notes ?? null,
        warmupSets: exercise.warmup?.sets ?? [],
        setNotes: resizeSetNotes(exercise.setNotes, exercise.sets),
        intent: createSuggestedSlotIntent(exercise.sets, index),
      }));
      return {
        lineageId: createId(),
        name: day.name,
        notes: day.notes ?? null,
        warmupNotes: day.warmupNotes ?? null,
        warmupItems: day.warmupNotes
          ? [{
              key: createId(),
              label: day.warmupNotes,
              reps: null,
              load: null,
              loadUnit: null,
              loadPercent: null,
              loadText: null,
              notes: null,
            }]
          : [],
        intent: createSuggestedDayIntent(exercises),
        supersets: Array.from(groupKeys, ([name, key]) => ({
          key,
          name,
          structureStatus: "canonical" as const,
          plannedRounds: day.exercises.find((exercise) => exercise.supersetGroup === name)?.sets ?? 1,
          restBetweenMembersSec: 0,
          restBetweenRoundsSec: 90,
          restAfterRoundSec: 90,
        })),
        exercises,
      };
    }),
  };
  return projectIntentProgramDocumentV2(rebuilt);
}

export function mergeProgramDocumentV2ChangesIntoV3(
  current: ProgramDocumentV3,
  changed: import("@/lib/program-document").ProgramDocument,
): ProgramDocumentV3 {
  const upgraded = upgradeStoredProgramDocumentToV3(changed);
  const currentDays = new Map(current.days.map((day) => [day.lineageId, day]));
  return programDocumentV3Schema.parse({
    ...upgraded,
    days: upgraded.days.map((day) => {
      const prior = currentDays.get(day.lineageId);
      if (!prior) return day;
      const priorGroups = new Map(prior.supersets.map((group) => [group.key, group]));
      return normalizeDaySupersets({
        ...day,
        warmupItems: prior.warmupItems,
        supersets: day.supersets.map((group) => {
          const priorGroup = priorGroups.get(group.key);
          return priorGroup
            ? {
                ...group,
                structureStatus: priorGroup.structureStatus,
                plannedRounds: priorGroup.plannedRounds,
                restBetweenMembersSec: priorGroup.restBetweenMembersSec,
                restBetweenRoundsSec: priorGroup.restBetweenRoundsSec,
                restAfterRoundSec: priorGroup.restBetweenRoundsSec,
              }
            : group;
        }),
      });
    }),
  });
}

export function replaceProgramExercise(
  slot: ProgramDocumentSlotV3,
  exerciseId: string,
  lineageId: string,
): ProgramDocumentSlotV3 {
  if (slot.exerciseId === exerciseId) return slot;
  return {
    ...slot,
    exerciseId,
    lineageId,
    supersetKey: null,
    groupMemberOrderIdx: null,
  };
}

/** Remove undersized groups and clear their remaining member references. */
export function normalizeDaySupersets(
  day: ProgramDocumentDayV3,
): ProgramDocumentDayV3 {
  const counts = new Map<string, number>();
  for (const slot of day.exercises) {
    if (slot.supersetKey) {
      counts.set(slot.supersetKey, (counts.get(slot.supersetKey) ?? 0) + 1);
    }
  }
  const valid = new Set(
    day.supersets
      .filter((group) => (counts.get(group.key) ?? 0) >= 2)
      .map((group) => group.key),
  );
  return {
    ...day,
    supersets: day.supersets
      .filter((group) => valid.has(group.key))
      .map((group) => {
        const members = day.exercises.filter(
          (slot) => slot.supersetKey === group.key,
        );
        const setCounts = new Set(members.map((slot) => slot.sets));
        const plannedRounds = setCounts.size === 1 ? members[0]?.sets ?? null : null;
        return {
          ...group,
          structureStatus: plannedRounds == null ? "legacy_unequal" as const : "canonical" as const,
          plannedRounds,
          restAfterRoundSec: group.restBetweenRoundsSec,
        };
      }),
    exercises: day.exercises.map((slot) => {
      if (!slot.supersetKey || !valid.has(slot.supersetKey)) {
        return { ...slot, supersetKey: null, groupMemberOrderIdx: null };
      }
      const members = day.exercises.filter(
        (candidate) => candidate.supersetKey === slot.supersetKey,
      );
      return {
        ...slot,
        groupMemberOrderIdx: members.findIndex(
          (candidate) => candidate.lineageId === slot.lineageId,
        ),
      };
    }),
  };
}

export function canCreateSuperset(day: ProgramDocumentDayV3) {
  return day.exercises.filter((slot) => slot.supersetKey == null).length >= 2;
}

export function resizeProgramSlotSets(
  slot: ProgramDocumentSlotV3,
  sets: number,
): ProgramDocumentSlotV3 {
  return {
    ...slot,
    sets,
    setNotes: resizeSetNotes(slot.setNotes, sets),
    intent: slot.intent.minimumDose.unit === "sets"
      ? {
          ...slot.intent,
          minimumDose: {
            ...slot.intent.minimumDose,
            value: Math.min(slot.intent.minimumDose.value, sets),
          },
          idealDose: {
            ...slot.intent.idealDose,
            value: Math.max(slot.intent.idealDose.value, sets),
          },
        }
      : slot.intent,
  };
}

export function addSupersetGroup(
  day: ProgramDocumentDayV3,
  group: ProgramDocumentDayV3["supersets"][number],
  selectedLineageIds?: string[],
): ProgramDocumentDayV3 {
  const selected = selectedLineageIds ? new Set(selectedLineageIds) : null;
  const eligibleMembers = day.exercises
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) =>
      slot.supersetKey == null && (!selected || selected.has(slot.lineageId)),
    );
  const memberIndexes = (selected ? eligibleMembers : eligibleMembers.slice(0, 2))
    .map(({ index }) => index);
  if (memberIndexes.length < 2) return day;
  return {
    ...day,
    supersets: [...day.supersets, group],
    exercises: day.exercises.map((slot, index) =>
      memberIndexes.includes(index)
        ? {
            ...resizeProgramSlotSets(slot, group.plannedRounds ?? slot.sets),
            supersetKey: group.key,
            groupMemberOrderIdx: memberIndexes.indexOf(index),
          }
        : slot,
    ),
  };
}

type WarmupSet = ProgramDocumentSlotV3["warmupSets"][number];

export function setWarmupNumericLoad<T extends WarmupSet>(
  warmup: T,
  load: number | null,
): T {
  return (load == null
    ? { ...warmup, load: null, loadUnit: null }
    : {
        ...warmup,
        load,
        loadUnit: warmup.loadUnit ?? "lb",
        loadPercent: null,
        loadText: null,
      }) as T;
}

export function setWarmupLoadPercent<T extends WarmupSet>(
  warmup: T,
  loadPercent: number | null,
): T {
  return (loadPercent == null
    ? { ...warmup, loadPercent: null }
    : {
        ...warmup,
        load: null,
        loadUnit: null,
        loadPercent,
        loadText: null,
      }) as T;
}

export function setWarmupLoadText<T extends WarmupSet>(
  warmup: T,
  loadText: string | null,
): T {
  return (loadText == null
    ? { ...warmup, loadText: null }
    : {
        ...warmup,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText,
      }) as T;
}

export function localProgramDraftKey(ownerId: string, draftId: string) {
  return `${PROGRAM_DRAFT_LOCAL_PREFIX}:${ownerId}:${draftId}`;
}

export function isLocallyRecoverableProgramDocument(
  value: unknown,
): value is ProgramDocumentV3 {
  try {
    if (!value || typeof value !== "object") return false;
    const stored = storedProgramDocumentSchema.safeParse(value);
    if (stored.success) {
      return programDocumentV3Schema.safeParse(
        upgradeStoredProgramDocumentToV3(stored.data),
      ).success;
    }
    const original = value as ProgramDocumentV3;
    if (!Array.isArray(original.days)) return false;
    const text = (candidate: unknown, max: number, fallback = "") => {
      if (typeof candidate !== "string") throw new Error("invalid text");
      return (candidate || fallback).slice(0, max);
    };
    const nullableText = (candidate: unknown, max: number) => {
      if (candidate == null) return null;
      return text(candidate, max);
    };
    const number = (
      candidate: unknown,
      min: number,
      max: number,
      integer = false,
    ) => {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        throw new Error("invalid number");
      }
      const bounded = Math.min(max, Math.max(min, candidate));
      return integer ? Math.trunc(bounded) : bounded;
    };
    const shadow: ProgramDocumentV3 = {
      ...original,
      name: text(original.name, 160, "Unsaved Program"),
      days: original.days.map((day) => ({
        ...day,
        name: text(day.name, 120, "Unsaved day"),
        notes: nullableText(day.notes, 2000),
        warmupNotes: nullableText(day.warmupNotes, 4000),
        warmupItems: day.warmupItems.map((item) => ({
          ...item,
          label: text(item.label, 120, "Unsaved warm-up"),
          reps: item.reps == null ? null : number(item.reps, 0, 1000, true),
          load: item.load == null ? null : number(item.load, 0, 100000),
          loadPercent: item.loadPercent == null ? null : number(item.loadPercent, 0, 500),
          loadText: nullableText(item.loadText, 160),
          notes: nullableText(item.notes, 500),
        })),
        supersets: day.supersets.map((group) => ({
          ...group,
          name: text(group.name, 80, "Unsaved superset"),
          plannedRounds: group.plannedRounds == null ? null : number(group.plannedRounds, 1, 20, true),
          restBetweenMembersSec: number(group.restBetweenMembersSec, 0, 1800, true),
          restBetweenRoundsSec: number(group.restBetweenRoundsSec, 0, 1800, true),
          restAfterRoundSec: number(group.restAfterRoundSec, 0, 1800, true),
        })),
        exercises: day.exercises.map((slot) => {
          const repMin = number(slot.repMin, 1, 100, true);
          const repMax = Math.max(repMin, number(slot.repMax, 1, 100, true));
          const targetLoad =
            slot.targetLoad == null
              ? null
              : normalizeStoredLoad(
                  number(slot.targetLoad, 0, MAX_STORED_LOAD)
                );
          if (![null, "lb", "kg"].includes(slot.targetLoadUnit)) {
            throw new Error("invalid load unit");
          }
          return {
            ...slot,
            sets: number(slot.sets, 1, 20, true),
            repMin,
            repMax,
            targetLoad,
            targetLoadUnit:
              targetLoad == null ? null : (slot.targetLoadUnit ?? "lb"),
            progressionRuleId: text(slot.progressionRuleId, 80, "unsaved"),
            restSec: number(slot.restSec, 0, 1800, true),
            notes: nullableText(slot.notes, 2000),
            warmupNotes: nullableText(slot.warmupNotes, 2000),
            warmupSets: slot.warmupSets.map((set) => {
              const loadText = nullableText(set.loadText, 160);
              const loadPercent =
                set.loadPercent == null
                  ? null
                  : number(set.loadPercent, 0, 500);
              const load =
                set.load == null ? null : number(set.load, 0, 100000);
              return {
                ...set,
                label: text(set.label, 120, "Unsaved warm-up"),
                reps: set.reps == null ? null : number(set.reps, 0, 1000, true),
                load: loadText != null || loadPercent != null ? null : load,
                loadUnit:
                  loadText != null || loadPercent != null || load == null
                    ? null
                    : (set.loadUnit ?? "lb"),
                loadPercent: loadText != null ? null : loadPercent,
                loadText,
                notes: nullableText(set.notes, 500),
              };
            }),
            setNotes: slot.setNotes.map((note) => nullableText(note, 500)),
          };
        }),
      })),
    };
    return programDocumentV3Schema.safeParse(shadow).success;
  } catch {
    return false;
  }
}

const FIELD_LABELS: Record<string, string> = {
  sets: "work sets",
  repMin: "minimum reps",
  repMax: "maximum reps",
  targetLoad: "target load",
  targetLoadUnit: "load unit",
  progressionRuleId: "progression rule",
  restSec: "rest",
  restAfterRoundSec: "round rest",
  notes: "notes",
  warmupNotes: "warm-up notes",
  warmupSets: "warm-up sets",
  setNotes: "work-set cues",
  supersets: "supersets",
  name: "name",
};

function readableFieldName(value: string) {
  return (
    FIELD_LABELS[value] ??
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase()
  );
}

export function formatProgramReviewValue(
  value: unknown,
  field?: string,
): string {
  if (field === "supersetKey") {
    return value ? "Linked to a superset" : "Not in a superset";
  }
  if (field === "progressionRuleId") {
    if (value === "double_progression") return "Double progression";
    if (value === "hold") return "Hold targets";
  }
  if (field === "restSec" || field === "restAfterRoundSec") {
    return value == null ? "None" : formatRestTime(Number(value));
  }
  if (value == null || value === "") return "None";
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value
      .map((item, index) => `${index + 1}. ${formatProgramReviewValue(item)}`)
      .join("; ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "key" && key !== "lineageId")
      .map(
        ([key, item]) =>
          `${readableFieldName(key)}: ${formatProgramReviewValue(item, key)}`,
      )
      .join("; ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function parseLocalProgramDraft(
  raw: string | null,
): LocalProgramDraft | null {
  if (!raw || raw.length > 750_000) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const currentDocument = storedProgramDocumentSchema.safeParse(value.document);
    const legacyDocument = legacyProgramDocumentSchema.safeParse(value.document);
    const document = currentDocument.success
      ? upgradeStoredProgramDocumentToV3(currentDocument.data)
      : legacyDocument.success
        ? upgradeStoredProgramDocumentToV3(suggestProgramIntentDraft(legacyDocument.data))
        : null;
    if (
      (value.schemaVersion !== PROGRAM_DRAFT_LOCAL_SCHEMA &&
        value.schemaVersion !== "2" &&
        value.schemaVersion !== "1") ||
      typeof value.ownerId !== "string" ||
      typeof value.draftId !== "string" ||
      !Number.isInteger(value.serverRevision) ||
      (value.serverRevision as number) < 0 ||
      typeof value.mutationId !== "string" ||
      typeof value.savedAt !== "string" ||
      !document ||
      !isLocallyRecoverableProgramDocument(document)
    ) {
      return null;
    }
    return {
      schemaVersion: PROGRAM_DRAFT_LOCAL_SCHEMA,
      ownerId: value.ownerId,
      draftId: value.draftId,
      serverRevision: value.serverRevision as number,
      mutationId: value.mutationId,
      document,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}
