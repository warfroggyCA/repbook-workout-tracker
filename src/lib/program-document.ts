import { z } from "zod";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().default(null);

export const programOutcomeSchema = z.enum([
  "strength",
  "hypertrophy",
  "skill",
  "conditioning",
  "work_capacity",
  "recovery",
]);

export const programDayIntentSchema = z
  .object({
    primaryOutcome: programOutcomeSchema,
    secondaryOutcomes: z.array(programOutcomeSchema).max(3),
    identity: z.object({
      kind: z.enum([
        "anchor_slots",
        "movement_balance",
        "muscle_emphasis",
        "skill_practice",
        "conditioning_focus",
        "recovery_session",
      ]),
      anchorSlotLineageIds: z.array(z.string().uuid()).max(12),
    }),
    targetDuration: z.object({
      minMinutes: z.number().int().min(5).max(600),
      maxMinutes: z.number().int().min(5).max(600),
    }),
    minimumUsefulDurationMinutes: z.number().int().min(5).max(600),
    fatigueTolerance: z.enum(["low", "normal", "high"]),
    orderingPolicy: z.enum(["preserve", "anchors_first", "flexible"]),
    pairingPolicy: z.enum(["preserve", "allow_compatible", "avoid_new"]),
    durationOverride: z
      .object({
        minMinutes: z.number().int().min(5).max(600),
        maxMinutes: z.number().int().min(5).max(600),
        note: z.string().trim().min(1).max(500),
      })
      .nullable(),
    note: nullableText(1000),
  })
  .superRefine((intent, context) => {
    if (intent.secondaryOutcomes.includes(intent.primaryOutcome)) {
      context.addIssue({
        code: "custom",
        path: ["secondaryOutcomes"],
        message: "A secondary outcome must differ from the primary outcome.",
      });
    }
    if (new Set(intent.secondaryOutcomes).size !== intent.secondaryOutcomes.length) {
      context.addIssue({
        code: "custom",
        path: ["secondaryOutcomes"],
        message: "Secondary outcomes must be unique.",
      });
    }
    if (intent.targetDuration.minMinutes > intent.targetDuration.maxMinutes) {
      context.addIssue({
        code: "custom",
        path: ["targetDuration", "maxMinutes"],
        message: "The target maximum must be at least the target minimum.",
      });
    }
    if (intent.minimumUsefulDurationMinutes > intent.targetDuration.maxMinutes) {
      context.addIssue({
        code: "custom",
        path: ["minimumUsefulDurationMinutes"],
        message: "The minimum useful duration cannot exceed the target maximum.",
      });
    }
    if (
      intent.durationOverride &&
      intent.durationOverride.minMinutes > intent.durationOverride.maxMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["durationOverride", "maxMinutes"],
        message: "The override maximum must be at least its minimum.",
      });
    }
  });

export const programDoseSchema = z.object({
  unit: z.enum(["sets", "minutes", "repetitions"]),
  value: z.number().int().min(1).max(1000),
});

export const programSlotIntentSchema = z
  .object({
    role: z.enum([
      "anchor",
      "support",
      "accessory",
      "skill",
      "conditioning",
      "recovery",
    ]),
    priority: z.enum(["must", "should", "could"]),
    minimumDose: programDoseSchema,
    idealDose: programDoseSchema,
    protectedOrder: z.boolean(),
    substitutionPolicy: z.enum([
      "exact_only",
      "approved_family",
      "approved_movement_pattern",
      "no_substitution",
    ]),
    omissionPolicy: z.enum(["never", "if_minimum_met", "allowed"]),
    calibrationEligible: z.boolean(),
    note: nullableText(1000),
  })
  .superRefine((intent, context) => {
    if (intent.minimumDose.unit !== intent.idealDose.unit) {
      context.addIssue({
        code: "custom",
        path: ["idealDose", "unit"],
        message: "Minimum and ideal dose must use the same unit.",
      });
    }
    if (intent.minimumDose.value > intent.idealDose.value) {
      context.addIssue({
        code: "custom",
        path: ["idealDose", "value"],
        message: "Ideal dose must be at least the minimum dose.",
      });
    }
  });

export const programWarmupSetSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    reps: z.number().int().min(0).max(1000).nullable().default(null),
    load: z.number().finite().min(0).max(100000).nullable().default(null),
    loadUnit: z.enum(["lb", "kg"]).nullable().default(null),
    loadPercent: z.number().finite().min(0).max(500).nullable().default(null),
    loadText: nullableText(160),
    notes: nullableText(500),
  })
  .superRefine((set, context) => {
    if ((set.load == null) !== (set.loadUnit == null)) {
      context.addIssue({
        code: "custom",
        path: ["loadUnit"],
        message: "A numeric warm-up load needs an explicit unit.",
      });
    }
    const loadingModes = [
      set.load != null,
      set.loadPercent != null,
      set.loadText != null,
    ].filter(Boolean).length;
    if (loadingModes > 1) {
      context.addIssue({
        code: "custom",
        path: ["load"],
        message: "Use only one warm-up loading method: a measured load, a percentage, or a written instruction.",
      });
    }
  });

export const programDayWarmupItemSchema = programWarmupSetSchema.extend({
  key: z.string().uuid(),
});

export const programExerciseGroupV3Schema = z.object({
  key: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  structureStatus: z.enum(["canonical", "legacy_unequal"]),
  plannedRounds: z.number().int().min(1).max(20).nullable(),
  restBetweenMembersSec: z.number().int().min(0).max(1800),
  restBetweenRoundsSec: z.number().int().min(0).max(1800),
  restAfterRoundSec: z.number().int().min(0).max(1800),
});

export const programSupersetSchema = z.object({
  key: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  restAfterRoundSec: z.number().int().min(0).max(1800),
});

const programSlotBaseSchema = z
  .object({
    lineageId: z.string().uuid(),
    exerciseId: z.string().uuid(),
    sets: z.number().int().min(1).max(20),
    repMin: z.number().int().min(1).max(100),
    repMax: z.number().int().min(1).max(100),
    targetLoad: z
      .number()
      .finite()
      .min(0)
      .max(MAX_STORED_LOAD)
      .nullable(),
    targetLoadUnit: z.enum(["lb", "kg"]).nullable(),
    progressionRuleId: z.string().trim().min(1).max(80),
    restSec: z.number().int().min(0).max(1800),
    supersetKey: z.string().uuid().nullable(),
    notes: nullableText(2000),
    warmupNotes: nullableText(2000),
    warmupSets: z.array(programWarmupSetSchema).max(12),
    setNotes: z.array(z.string().trim().max(500).nullable()).max(20),
  })
  .superRefine((slot, context) => {
    if (slot.repMin > slot.repMax) {
      context.addIssue({
        code: "custom",
        path: ["repMax"],
        message: "Maximum reps must be at least minimum reps.",
      });
    }
    if ((slot.targetLoad == null) !== (slot.targetLoadUnit == null)) {
      context.addIssue({
        code: "custom",
        path: ["targetLoadUnit"],
        message: "A numeric target load needs an explicit unit.",
      });
    }
    if (slot.setNotes.length !== slot.sets) {
      context.addIssue({
        code: "custom",
        path: ["setNotes"],
        message: "Work-set notes must match the number of prescribed sets.",
      });
    }
  });

export const legacyProgramSlotSchema = programSlotBaseSchema;
export const programSlotSchema = programSlotBaseSchema.extend({
  intent: programSlotIntentSchema,
});
export const programSlotV3Schema = programSlotSchema.extend({
  groupMemberOrderIdx: z.number().int().min(0).nullable(),
});

function refineProgramDay(
  day: z.infer<typeof programDayBaseSchema>,
  context: z.RefinementCtx,
) {
  const groupKeys = new Set(day.supersets.map((group) => group.key));
  if (groupKeys.size !== day.supersets.length) {
    context.addIssue({
      code: "custom",
      path: ["supersets"],
      message: "Superset identities must be unique within a day.",
    });
  }
  const members = new Map<string, number>();
  for (const [index, slot] of day.exercises.entries()) {
    if (!slot.supersetKey) continue;
    if (!groupKeys.has(slot.supersetKey)) {
      context.addIssue({
        code: "custom",
        path: ["exercises", index, "supersetKey"],
        message: "This exercise refers to a superset that is not in its day.",
      });
    }
    members.set(slot.supersetKey, (members.get(slot.supersetKey) ?? 0) + 1);
  }
  for (const [index, group] of day.supersets.entries()) {
    if ((members.get(group.key) ?? 0) < 2) {
      context.addIssue({
        code: "custom",
        path: ["supersets", index],
        message: "A superset needs at least two exercises.",
      });
    }
  }
}

const programDayBaseSchema = z.object({
  lineageId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  notes: nullableText(2000),
  warmupNotes: nullableText(4000),
  supersets: z.array(programSupersetSchema).max(20),
  exercises: z.array(programSlotBaseSchema).min(1).max(60),
});

export const legacyProgramDaySchema = programDayBaseSchema.superRefine(refineProgramDay);

export const programDaySchema = z
  .object({
    lineageId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    notes: nullableText(2000),
    // Added without changing the document version so saved v1 drafts and
    // device recovery records normalize safely at this strict boundary.
    warmupNotes: nullableText(4000),
    intent: programDayIntentSchema,
    supersets: z.array(programSupersetSchema).max(20),
    exercises: z.array(programSlotSchema).min(1).max(60),
  })
  .superRefine((day, context) => {
    refineProgramDay(day, context);
    const slotLineages = new Set(day.exercises.map((slot) => slot.lineageId));
    for (const [index, anchor] of day.intent.identity.anchorSlotLineageIds.entries()) {
      if (!slotLineages.has(anchor)) {
        context.addIssue({
          code: "custom",
          path: ["intent", "identity", "anchorSlotLineageIds", index],
          message: "A day identity anchor must refer to an exercise in this day.",
        });
      }
    }
    if (
      day.intent.identity.kind === "anchor_slots" &&
      day.intent.identity.anchorSlotLineageIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["intent", "identity", "anchorSlotLineageIds"],
        message: "An anchor-based day identity needs at least one anchor exercise.",
      });
    }
    for (const [index, slot] of day.exercises.entries()) {
      if (
        slot.intent.minimumDose.unit === "sets" &&
        (slot.sets < slot.intent.minimumDose.value ||
          slot.sets > slot.intent.idealDose.value)
      ) {
        context.addIssue({
          code: "custom",
          path: ["exercises", index, "intent", "minimumDose"],
          message: "Planned sets must fall between the minimum and ideal set dose.",
        });
      }
    }
  });

export const programDayV3Schema = z
  .object({
    lineageId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    notes: nullableText(2000),
    warmupNotes: nullableText(4000),
    warmupItems: z.array(programDayWarmupItemSchema).max(24),
    intent: programDayIntentSchema,
    supersets: z.array(programExerciseGroupV3Schema).max(20),
    exercises: z.array(programSlotV3Schema).min(1).max(60),
  })
  .superRefine((day, context) => {
    refineProgramDay(day, context);
    const warmupKeys = new Set<string>();
    for (const [itemIndex, item] of day.warmupItems.entries()) {
      if (warmupKeys.has(item.key)) {
        context.addIssue({
          code: "custom",
          path: ["warmupItems", itemIndex, "key"],
          message: "Warm-up item keys must be unique within a day.",
        });
      }
      warmupKeys.add(item.key);
    }
    const groupByKey = new Map(day.supersets.map((group) => [group.key, group]));
    for (const [groupIndex, group] of day.supersets.entries()) {
      const members = day.exercises.filter(
        (slot) => slot.supersetKey === group.key,
      );
      const orders = members
        .map((slot) => slot.groupMemberOrderIdx)
        .sort((left, right) => Number(left) - Number(right));
      const contiguous = orders.every((order, index) => order === index);
      if (!contiguous) {
        context.addIssue({
          code: "custom",
          path: ["supersets", groupIndex],
          message: "Group member order must be unique and contiguous from zero.",
        });
      }
      const setCounts = new Set(members.map((slot) => slot.sets));
      if (
        group.structureStatus === "canonical" &&
        (group.plannedRounds == null ||
          setCounts.size !== 1 ||
          members[0]?.sets !== group.plannedRounds)
      ) {
        context.addIssue({
          code: "custom",
          path: ["supersets", groupIndex, "plannedRounds"],
          message: "Canonical group members must all match the planned rounds.",
        });
      }
      if (
        group.structureStatus === "legacy_unequal" &&
        group.plannedRounds !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["supersets", groupIndex, "plannedRounds"],
          message: "An unequal legacy group cannot claim canonical rounds.",
        });
      }
      if (group.restAfterRoundSec !== group.restBetweenRoundsSec) {
        context.addIssue({
          code: "custom",
          path: ["supersets", groupIndex, "restAfterRoundSec"],
          message: "The compatibility round rest must match between-round rest.",
        });
      }
    }
    for (const [slotIndex, slot] of day.exercises.entries()) {
      if (
        (slot.supersetKey == null) !== (slot.groupMemberOrderIdx == null) ||
        (slot.supersetKey != null && !groupByKey.has(slot.supersetKey))
      ) {
        context.addIssue({
          code: "custom",
          path: ["exercises", slotIndex, "groupMemberOrderIdx"],
          message: "Only grouped exercises may have a group member order.",
        });
      }
    }
  });

function refineProgramDocument(
  document: { days: Array<{ lineageId: string; exercises: Array<{ lineageId: string }> }> },
  context: z.RefinementCtx,
) {
  const dayLineages = new Set<string>();
  const slotLineages = new Set<string>();
  for (const [dayIndex, day] of document.days.entries()) {
    if (dayLineages.has(day.lineageId)) {
      context.addIssue({
        code: "custom",
        path: ["days", dayIndex, "lineageId"],
        message: "Day lineage must be unique in a Program version.",
      });
    }
    dayLineages.add(day.lineageId);
    for (const [slotIndex, slot] of day.exercises.entries()) {
      if (slotLineages.has(slot.lineageId)) {
        context.addIssue({
          code: "custom",
          path: ["days", dayIndex, "exercises", slotIndex, "lineageId"],
          message: "Exercise-slot lineage must be unique in a Program version.",
        });
      }
      slotLineages.add(slot.lineageId);
    }
  }
}

export const legacyProgramDocumentSchema = z
  .object({
    schemaVersion: z.literal("1"),
    programId: z.string().uuid(),
    baseVersionId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    days: z.array(legacyProgramDaySchema).min(1).max(14),
  })
  .superRefine(refineProgramDocument);

export const programDocumentSchema = z
  .object({
    schemaVersion: z.literal("2"),
    programId: z.string().uuid(),
    baseVersionId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    days: z.array(programDaySchema).min(1).max(14),
  })
  .superRefine(refineProgramDocument);

export const programDocumentV3Schema = z
  .object({
    schemaVersion: z.literal("3"),
    programId: z.string().uuid(),
    baseVersionId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    days: z.array(programDayV3Schema).min(1).max(14),
  })
  .superRefine(refineProgramDocument);

export const storedProgramDocumentSchema = z.discriminatedUnion("schemaVersion", [
  legacyProgramDocumentSchema,
  programDocumentSchema,
  programDocumentV3Schema,
]);

export type ProgramDocument = z.infer<typeof programDocumentSchema>;
export type LegacyProgramDocument = z.infer<typeof legacyProgramDocumentSchema>;
export type StoredProgramDocument = z.infer<typeof storedProgramDocumentSchema>;
export type ProgramDocumentV3 = z.infer<typeof programDocumentV3Schema>;
export type ProgramDayWarmupItem = z.infer<typeof programDayWarmupItemSchema>;
export type ProgramDocumentDayV3 = z.infer<typeof programDayV3Schema>;
export type ProgramDocumentSlotV3 = z.infer<typeof programSlotV3Schema>;
export type ProgramDocumentGroupV3 = z.infer<typeof programExerciseGroupV3Schema>;
export type ProgramDocumentDay = z.infer<typeof programDaySchema>;
export type ProgramDocumentSlot = z.infer<typeof programSlotSchema>;
export type ProgramDocumentSuperset = z.infer<typeof programSupersetSchema>;
export type ProgramDayIntent = z.infer<typeof programDayIntentSchema>;
export type ProgramSlotIntent = z.infer<typeof programSlotIntentSchema>;

export function overviewWarmupLabels(value: string | null): string[] {
  return (value?.split(/\r?\n/) ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const chunks: string[] = [];
      for (let index = 0; index < line.length; index += 120) {
        chunks.push(line.slice(index, index + 120));
      }
      return chunks;
    });
}

/**
 * Identifies the draft-only compatibility steps created from a legacy
 * free-text overview. Authored structured steps use independent identities
 * and are never treated as generated overview projections.
 */
export function hasGeneratedOverviewWarmupItems(
  day: Pick<
    ProgramDocumentDayV3,
    "lineageId" | "warmupNotes" | "warmupItems"
  >,
  compatibilityKeys: readonly string[] = [],
): boolean {
  const first = day.warmupItems[0];
  if (
    !first ||
    (first.key !== day.lineageId && !compatibilityKeys.includes(first.key)) ||
    !day.warmupNotes
  ) {
    return false;
  }
  const hasOnlyPlainItems = day.warmupItems.every((item) =>
    item.reps == null &&
    item.load == null &&
    item.loadUnit == null &&
    item.loadPercent == null &&
    item.loadText == null &&
    item.notes == null
  );
  if (!hasOnlyPlainItems) return false;
  const projectedLabels = overviewWarmupLabels(day.warmupNotes);
  return (
    (day.warmupItems.length === 1 &&
      (first.label === day.warmupNotes ||
        first.label === day.warmupNotes.slice(0, 120))) ||
    day.warmupItems.map((item) => item.label).join("\n") ===
      projectedLabels.join("\n")
  );
}

export function createSuggestedSlotIntent(
  sets: number,
  index: number,
): ProgramSlotIntent {
  return {
    role: index === 0 ? "anchor" : index < 3 ? "support" : "accessory",
    priority: index === 0 ? "must" : index < 3 ? "should" : "could",
    minimumDose: {
      unit: "sets",
      value: index === 0 ? Math.min(sets, 2) : 1,
    },
    idealDose: { unit: "sets", value: sets },
    protectedOrder: index === 0,
    substitutionPolicy: index === 0 ? "exact_only" : "approved_family",
    omissionPolicy: index === 0 ? "never" : "if_minimum_met",
    calibrationEligible: index === 0,
    note: null,
  };
}

export function createSuggestedDayIntent(
  exercises: Array<Pick<ProgramDocumentSlot, "lineageId" | "sets" | "restSec">>,
): ProgramDayIntent {
  const plannedMinutes = Math.max(
    5,
    Math.ceil(
      exercises.reduce(
        (seconds, slot) =>
          seconds + slot.sets * 45 + Math.max(0, slot.sets - 1) * slot.restSec,
        0,
      ) / 300,
    ) * 5,
  );
  const targetMax = Math.min(600, Math.max(20, plannedMinutes + 10));
  const targetMin = Math.max(5, targetMax - 10);
  const anchor = exercises[0]?.lineageId;
  return {
    primaryOutcome: "strength",
    secondaryOutcomes: [],
    identity: {
      kind: "anchor_slots",
      anchorSlotLineageIds: anchor ? [anchor] : [],
    },
    targetDuration: { minMinutes: targetMin, maxMinutes: targetMax },
    minimumUsefulDurationMinutes: Math.max(5, targetMin - 10),
    fatigueTolerance: "normal",
    orderingPolicy: "anchors_first",
    pairingPolicy: "preserve",
    durationOverride: null,
    note: null,
  };
}

function warmupSetText(
  set: ProgramDocumentSlot["warmupSets"][number],
): string {
  const details = [
    set.reps == null ? null : `${set.reps} reps`,
    set.load == null ? null : `${set.load} ${set.loadUnit}`,
    set.loadPercent == null ? null : `${set.loadPercent}% of work weight`,
    set.loadText,
    set.notes,
  ].filter((value): value is string => Boolean(value));
  return details.length ? `${set.label} — ${details.join(" · ")}` : set.label;
}

/**
 * Moves legacy per-exercise warm-ups and work-set cues into the ordinary
 * day/exercise fields used by the redesigned editor. This changes only the
 * editable document passed to it; activated versions and workout snapshots are
 * never updated.
 */
export function convertLegacyProgramGuidance(
  document: ProgramDocument,
  exerciseName: (exerciseId: string) => string = () => "Exercise",
): { document: ProgramDocument; changed: boolean } {
  let changed = false;
  const next: ProgramDocument = {
    ...document,
    days: document.days.map((day) => {
      const warmupLines = day.warmupNotes ? [day.warmupNotes] : [];
      const exercises = day.exercises.map((slot) => {
        const name = exerciseName(slot.exerciseId);
        if (slot.warmupNotes) {
          warmupLines.push(`${name}: ${slot.warmupNotes}`);
          changed = true;
        }
        for (const set of slot.warmupSets) {
          warmupLines.push(`Before ${name}: ${warmupSetText(set)}`);
          changed = true;
        }
        const cues = slot.setNotes
          .map((cue, index) => (cue ? `Set ${index + 1}: ${cue}` : null))
          .filter((value): value is string => Boolean(value));
        if (cues.length > 0) changed = true;
        const cueText = cues.length > 0 ? `Work-set cues: ${cues.join("; ")}` : null;
        return {
          ...slot,
          notes: [slot.notes, cueText].filter(Boolean).join("\n") || null,
          warmupNotes: null,
          warmupSets: [],
          setNotes: Array.from({ length: slot.sets }, () => null),
        };
      });
      return {
        ...day,
        warmupNotes: warmupLines.join("\n").trim() || null,
        exercises,
      };
    }),
  };
  return { document: next, changed };
}

export function normalizeLegacyProgramWarmupSet(
  value: unknown,
): ProgramDocumentSlot["warmupSets"][number] {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const normalized = {
    ...source,
    reps: source.reps ?? null,
    load: source.load ?? null,
    loadUnit: source.loadUnit ?? null,
    loadPercent: source.loadPercent ?? null,
    loadText: source.loadText ?? null,
    notes: source.notes ?? null,
  };
  if (normalized.load != null) {
    normalized.loadPercent = null;
    normalized.loadText = null;
  } else if (normalized.loadPercent != null) {
    normalized.loadText = null;
  }
  return programWarmupSetSchema.parse(normalized);
}

export function normalizeProgramDocumentLoads(
  document: ProgramDocument
): ProgramDocument {
  return {
    ...document,
    days: document.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((slot) => ({
        ...slot,
        targetLoad:
          slot.targetLoad == null
            ? null
            : normalizeStoredLoad(slot.targetLoad),
      })),
    })),
  };
}

export function normalizeStoredProgramDocumentLoads(
  document: StoredProgramDocument,
): StoredProgramDocument {
  return {
    ...document,
    days: document.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((slot) => ({
        ...slot,
        targetLoad:
          slot.targetLoad == null
            ? null
            : normalizeStoredLoad(slot.targetLoad),
      })),
    })),
  } as StoredProgramDocument;
}

export function suggestProgramIntentDraft(
  document: LegacyProgramDocument,
): ProgramDocument {
  return programDocumentSchema.parse({
    ...document,
    schemaVersion: "2",
    days: document.days.map((day) => {
      const upgradedExercises = day.exercises.map((slot, index) => ({
        ...slot,
        intent: createSuggestedSlotIntent(slot.sets, index),
      }));
      return {
        ...day,
        intent: createSuggestedDayIntent(upgradedExercises),
        exercises: upgradedExercises,
      };
    }),
  });
}

/**
 * Builds the current editor shape from an immutable stored Program version.
 * This is the single authority for automatic, draft-only schema and guidance
 * preparation. It never mutates or republishes the supplied version.
 */
export function prepareProgramDocumentForEditing(
  stored: StoredProgramDocument,
  exerciseName: (exerciseId: string) => string = () => "Exercise",
): ProgramDocumentV3 {
  if (stored.schemaVersion === "3") {
    return upgradeStoredProgramDocumentToV3(stored);
  }
  const intentDocument = stored.schemaVersion === "1"
    ? suggestProgramIntentDraft(stored)
    : stored;
  const guidanceDocument = convertLegacyProgramGuidance(
    intentDocument,
    exerciseName,
  ).document;
  return upgradeStoredProgramDocumentToV3(guidanceDocument);
}

export function isIntentBearingProgramDocument(
  document: StoredProgramDocument,
): document is ProgramDocument | ProgramDocumentV3 {
  return document.schemaVersion === "2" || document.schemaVersion === "3";
}

export function projectIntentProgramDocumentV2(
  document: ProgramDocument | ProgramDocumentV3,
): ProgramDocument {
  if (document.schemaVersion === "2") return document;
  return programDocumentSchema.parse({
    ...document,
    schemaVersion: "2",
    days: document.days.map((day) => ({
      lineageId: day.lineageId,
      name: day.name,
      notes: day.notes,
      warmupNotes: day.warmupNotes,
      intent: day.intent,
      supersets: day.supersets.map((group) => ({
        key: group.key,
        name: group.name,
        restAfterRoundSec: group.restBetweenRoundsSec,
      })),
      exercises: day.exercises.map((slot) => {
        const { groupMemberOrderIdx, ...v2Slot } = slot;
        void groupMemberOrderIdx;
        return v2Slot;
      }),
    })),
  });
}

export function upgradeStoredProgramDocumentToV3(
  stored: StoredProgramDocument,
): ProgramDocumentV3 {
  if (stored.schemaVersion === "3") {
    return programDocumentV3Schema.parse({
      ...structuredClone(stored),
      days: stored.days.map((day) => ({
        ...day,
        warmupItems: hasGeneratedOverviewWarmupItems(day)
          ? []
          : day.warmupItems,
      })),
    });
  }
  const intentDocument = stored.schemaVersion === "1"
    ? suggestProgramIntentDraft(stored)
    : stored;

  return programDocumentV3Schema.parse({
    ...intentDocument,
    schemaVersion: "3",
    days: intentDocument.days.map((day) => {
      const membersByGroup = new Map<string, typeof day.exercises>();
      for (const slot of day.exercises) {
        if (!slot.supersetKey) continue;
        const members = membersByGroup.get(slot.supersetKey) ?? [];
        members.push(slot);
        membersByGroup.set(slot.supersetKey, members);
      }
      const memberOrder = new Map<string, number>();
      for (const members of membersByGroup.values()) {
        members.forEach((slot, index) => memberOrder.set(slot.lineageId, index));
      }
      return {
        ...day,
        // Legacy warm-ups remain free text. Empty structured steps make every
        // current consumer use the complete overview instead of a 120-character
        // compatibility projection.
        warmupItems: [],
        supersets: day.supersets.map((group) => {
          const members = membersByGroup.get(group.key) ?? [];
          const setCounts = new Set(members.map((slot) => slot.sets));
          const plannedRounds = setCounts.size === 1 ? members[0]?.sets ?? null : null;
          return {
            key: group.key,
            name: group.name,
            structureStatus:
              plannedRounds == null ? "legacy_unequal" as const : "canonical" as const,
            plannedRounds,
            restBetweenMembersSec: 0,
            restBetweenRoundsSec: group.restAfterRoundSec,
            restAfterRoundSec: group.restAfterRoundSec,
          };
        }),
        exercises: day.exercises.map((slot) => ({
          ...slot,
          setNotes: Array.from(
            { length: slot.sets },
            (_, index) => slot.setNotes[index] ?? null,
          ),
          groupMemberOrderIdx: slot.supersetKey
            ? memberOrder.get(slot.lineageId) ?? null
            : null,
        })),
      };
    }),
  });
}
