"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import {
  aiParsingEvents,
  constraints as constraintsTable,
  userProfiles,
} from "@/db/schema";
import type {
  RoutineWarmup,
  RoutineWarmupSet,
  SetupState,
} from "@/db/schema/user";
import { getCurrentUser, type CurrentUser } from "@/lib/user";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import { logDiagnosticEvent } from "@/lib/server-log";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";
import {
  exerciseNameSimilarity,
  extractExplicitWorkExerciseNames,
  routineBuildContextForRequest,
  splitRoutineBuildRequests,
  type RoutineBuildProgramContext,
} from "@/lib/routine-build-chunks";
import {
  programDocumentSchema,
  type ProgramDocument,
} from "@/lib/program-document";
import { isAIAvailable, AIUnavailableError, type AIResult } from "@/ai/provider";
import type { AIEnvelope } from "@/ai/envelope";
import {
  equipmentParseSchema,
  equipmentParseData,
  type EquipmentParseResult,
} from "@/ai/tasks/equipment-parse/schema";
import { EQUIPMENT_PARSE_SYSTEM } from "@/ai/tasks/equipment-parse/prompt";
import {
  routineBuildSchema,
  type RoutineBuildData,
  type RoutineBuildExercise,
} from "@/ai/tasks/routine-build/schema";
import { ROUTINE_BUILD_SYSTEM } from "@/ai/tasks/routine-build/prompt";
import {
  amberFields,
  confirmedEquipmentItemSchema,
  type ConfirmedEquipmentItem,
} from "@/ai/tasks/equipment-parse/confirm";
import { BODY_REGION_PATTERNS, type SetupStepSlug } from "@/lib/setup-steps";
import { getLibraryWithAvailability } from "@/services/routine-import";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import {
  saveConstraintsWithVersions,
  saveInventoryWithVersions,
} from "@/services/setup-persistence";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  rawDataExpiresAt,
  sensitiveTextSha256,
} from "@/lib/privacy-retention";
import {
  AIControlError,
  runControlledStructuredGeneration,
} from "@/services/ai-control";

/** Append a completed step to the profile's setup state (idempotent). */
async function markStepComplete(
  db: Db,
  user: CurrentUser,
  slug: SetupStepSlug,
  extra?: Partial<SetupState>
) {
  const state = user.profile.setupState;
  const completedSteps = state.completedSteps.includes(slug)
    ? state.completedSteps
    : [...state.completedSteps, slug];
  await db
    .update(userProfiles)
    .set({
      setupState: { ...state, ...extra, completedSteps },
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.id, user.profile.id));
}

// ---------------------------------------------------------------------------
// Step 1 — profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  ageRange: z.string().min(1).max(20),
  experience: z.enum(["novice", "intermediate", "advanced"]),
  goals: z.array(z.enum(["strength", "tone", "consistency"])).min(1),
  sessionLengthMin: z.number().int().min(15).max(120),
  weeklyFrequency: z.number().int().min(1).max(7),
  unit: z.enum(["lb", "kg"]),
});

export async function saveProfileStep(
  input: z.infer<typeof profileSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the form values." };
  const user = await getCurrentUser();
  const db = await getDb();

  await db
    .update(userProfiles)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(userProfiles.id, user.profile.id));
  await markStepComplete(db, user, "profile");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 2 — equipment (AI parse path)
// ---------------------------------------------------------------------------

export type EquipmentParseResponse =
  | {
      ok: true;
      parsingEventId: string;
      envelope: AIEnvelope<z.infer<typeof equipmentParseData>>;
    }
  | { ok: false; reason: string };

/**
 * Plan §13 contract 1: parse messy equipment text. The parse is quarantined
 * on an AIParsingEvent (scope "setup") — nothing touches inventory tables
 * until confirmSetupEquipment.
 */
export async function parseSetupEquipment(
  input: string
): Promise<EquipmentParseResponse> {
  const text = z.string().min(1).max(4000).parse(input).trim();
  const user = await getCurrentUser();
  const db = await getDb();

  if (!isAIAvailable()) {
    return {
      ok: false,
      reason:
        "AI parsing isn't configured. Use the checklist — it covers the same ground.",
    };
  }

  let result: AIResult<EquipmentParseResult>;
  try {
    result = await runControlledStructuredGeneration(db, user.id, {
      task: "equipment_parse",
      system: EQUIPMENT_PARSE_SYSTEM,
      input: text,
      schema: equipmentParseSchema,
    });
  } catch (err) {
    if (err instanceof AIUnavailableError) return { ok: false, reason: err.message };
    if (err instanceof AIControlError) return { ok: false, reason: err.message };
    logDiagnosticEvent("ai.setup_equipment_parse_failed", {
      ...sanitizeAIProviderError(err),
    });
    return {
      ok: false,
      reason: "The parser had trouble with that. Try again or use the checklist.",
    };
  }

  const envelope = result.value;
  const [event] = await db
    .insert(aiParsingEvents)
    .values({
      userId: user.id,
      scope: "setup",
      task: "equipment_parse",
      rawInput: text,
      inputSha256: sensitiveTextSha256(text),
      rawOutput: result.rawText,
      parsedJson: envelope,
      confidence: envelope.confidence,
      ambiguities: envelope.ambiguities,
      model: result.model,
      latencyMs: result.latencyMs,
      retentionExpiresAt: rawDataExpiresAt(),
    })
    .returning();

  return { ok: true, parsingEventId: event.id, envelope };
}

/** Reject while any amber (ambiguous) field is unresolved — the iron gate. */
function findUnresolved(items: ConfirmedEquipmentItem[]): string | null {
  for (const item of items) {
    const fields = amberFields(item);
    if (fields.length) {
      return `"${item.label}" still needs: ${fields.join(", ")}.`;
    }
  }
  return null;
}

const confirmEquipmentSchema = z.object({
  parsingEventId: z.string().uuid(),
  /** Items as edited on the confirmation screen; discarded ones omitted. */
  items: z.array(confirmedEquipmentItemSchema).min(1),
});

/**
 * The confirmation gate for equipment (plan §4 step 2): the ONLY writer of
 * AI-parsed inventory. Refuses to save while any ambiguous field (unit,
 * adjustable, pair, plate denominations) is unresolved.
 */
export async function confirmSetupEquipment(
  input: z.infer<typeof confirmEquipmentSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = confirmEquipmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the item fields." };
  const user = await getCurrentUser();
  const db = await getDb();

  const event = await db.query.aiParsingEvents.findFirst({
    where: and(
      eq(aiParsingEvents.id, parsed.data.parsingEventId),
      eq(aiParsingEvents.userId, user.id),
      eq(aiParsingEvents.scope, "setup")
    ),
  });
  if (!event) return { ok: false, reason: "Parse not found." };
  if (event.confirmed) return { ok: false, reason: "Already saved." };

  // The stored parse must still be a valid envelope — stale parses never apply.
  const stored = equipmentParseSchema.safeParse(event.parsedJson);
  if (!stored.success) {
    return { ok: false, reason: "Stored parse is invalid and cannot be saved." };
  }

  const unresolved = findUnresolved(parsed.data.items);
  if (unresolved) return { ok: false, reason: unresolved };

  const saved = await saveInventoryWithVersions(
    db,
    user.id,
    parsed.data.items,
    event.id
  );
  if (!saved.ok) return saved;
  revalidatePath("/setup");
  return { ok: true };
}

const checklistSchema = z.object({
  // An empty inventory is a valid bodyweight-only setup. The availability
  // engine provides bodyweight without forcing a synthetic equipment row.
  items: z.array(confirmedEquipmentItemSchema).max(200),
});

/** Form-path save: same gate and writer, no AI event involved. */
export async function saveEquipmentChecklist(
  input: z.infer<typeof checklistSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = checklistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the item fields." };
  const user = await getCurrentUser();
  const db = await getDb();

  const unresolved = findUnresolved(parsed.data.items);
  if (unresolved) return { ok: false, reason: unresolved };

  const saved = await saveInventoryWithVersions(db, user.id, parsed.data.items);
  if (!saved.ok) return saved;
  revalidatePath("/setup");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 3 — constraints
// ---------------------------------------------------------------------------

const constraintRegionSchema = z
  .object({
    bodyPart: z.enum(
      Object.keys(BODY_REGION_PATTERNS) as [string, ...string[]]
    ),
    avoidPatterns: z.array(z.string()),
    cautiousPatterns: z.array(z.string()),
    painStopThreshold: z.number().int().min(1).max(10),
    note: z.string().max(500).nullable(),
  })
  .refine(
    (r) =>
      [...r.avoidPatterns, ...r.cautiousPatterns].every((p) =>
        BODY_REGION_PATTERNS[r.bodyPart]?.includes(p)
      ),
    { message: "Patterns must belong to the body region." }
  );

const constraintsInputSchema = z.object({
  regions: z.array(constraintRegionSchema).max(10),
});

export async function saveSetupConstraints(
  input: z.infer<typeof constraintsInputSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = constraintsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the constraint values." };
  const user = await getCurrentUser();
  const db = await getDb();

  const saved = await saveConstraintsWithVersions(db, user.id, parsed.data.regions);
  if (!saved.ok) return saved;
  revalidatePath("/setup");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 4 — routine (manual builder; draft lives in setupState until step 6)
// ---------------------------------------------------------------------------

const draftExerciseSchema = z
  .object({
    exerciseId: z.string().uuid(),
    name: z.string().min(1).max(120),
    sets: z.number().int().min(1).max(10),
    repMin: z.number().int().min(1).max(50),
    repMax: z.number().int().min(1).max(50),
    targetLoad: z
      .number()
      .finite()
      .min(0)
      .max(MAX_STORED_LOAD)
      .transform(normalizeStoredLoad)
      .nullable(),
    targetLoadUnit: z.enum(["lb", "kg"]).nullable(),
    restSec: z.number().int().min(0).max(600),
    supersetGroup: z.string().max(2).nullable(),
    notes: z.string().max(500).nullable(),
    warmup: z
      .object({
        notes: z.string().max(1000).nullable(),
        sets: z
          .array(
            z
              .object({
                label: z.string().max(80),
                reps: z.number().int().min(0).max(100).nullable(),
                load: z.number().min(0).max(2000).nullable(),
                loadUnit: z.enum(["lb", "kg"]).nullable(),
                loadPercent: z.number().min(0).max(100).nullable(),
                loadText: z.string().max(80).nullable(),
                notes: z.string().max(300).nullable(),
              })
              .refine((set) => (set.load == null) === (set.loadUnit == null), {
                message: "Numeric warm-up loads require one explicit unit.",
                path: ["loadUnit"],
              })
          )
          .max(8),
      })
      .nullable()
      .default(null),
    setNotes: z.array(z.string().max(300).nullable()).max(10).default([]),
  })
  .refine(
    (exercise) =>
      (exercise.targetLoad == null) === (exercise.targetLoadUnit == null),
    { message: "Target loads require one explicit unit.", path: ["targetLoadUnit"] }
  )
  .transform((ex) => ({
    ...ex,
    name: ex.name.trim(),
    restSec: snapRestSec(ex.restSec),
    supersetGroup: ex.supersetGroup?.trim() || null,
    notes: ex.notes?.trim() || null,
    warmup: normalizeWarmupDraft(ex.warmup),
    setNotes: normalizeSetNotes(ex.setNotes, ex.sets),
  }));

const routineDraftSchema = z.object({
  days: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        notes: z.string().trim().max(2000).nullable().default(null),
        warmupNotes: z.string().trim().max(4000).nullable().default(null),
        exercises: z.array(draftExerciseSchema).min(1).max(15),
      })
    )
    .min(1)
    .max(7),
});

export type RoutineDraft = z.infer<typeof routineDraftSchema>;

function snapRestSec(seconds: number): number {
  return Math.max(0, Math.min(600, Math.round(seconds / 15) * 15));
}

function normalizeSetNotes(
  notes: Array<string | null> | undefined,
  sets: number
): Array<string | null> {
  return Array.from({ length: sets }, (_, i) => notes?.[i]?.trim() || null);
}

function normalizeWarmupDraft(
  warmup: RoutineWarmup | null
): RoutineWarmup | null {
  if (!warmup) return null;
  const notes = warmup.notes?.trim() || null;
  const sets = warmup.sets
    .map((set): RoutineWarmupSet | null => {
      const label = set.label.trim();
      const loadText = set.loadText?.trim() || null;
      const setNotes = set.notes?.trim() || null;
      const hasDetails =
        !!label ||
        set.reps != null ||
        set.load != null ||
        set.loadPercent != null ||
        !!loadText ||
        !!setNotes;
      if (!hasDetails) return null;
      return {
        ...set,
        label: label || "Warm-up set",
        loadText,
        notes: setNotes,
      };
    })
    .filter((set): set is NonNullable<typeof set> => set != null);
  if (!notes && sets.length === 0) return null;
  return { notes, sets };
}

export async function saveRoutineDraft(
  input: z.infer<typeof routineDraftSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = routineDraftSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "Every day needs a name and at least one exercise with rep range 1–50.",
    };
  }
  for (const day of parsed.data.days) {
    for (const ex of day.exercises) {
      if (ex.repMax < ex.repMin) {
        return { ok: false, reason: `${ex.name}: max reps below min reps.` };
      }
    }
  }
  const user = await getCurrentUser();
  const db = await getDb();

  // Every exercise must resolve to a real library/user exercise (plan §4).
  const ids = [
    ...new Set(parsed.data.days.flatMap((d) => d.exercises.map((e) => e.exerciseId))),
  ];
  const library = await getLibraryWithAvailability(db, user.id);
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const missing = ids.filter((id) => !libraryById.has(id));
  if (missing.length) {
    return { ok: false, reason: "An exercise no longer exists — remove and re-add it." };
  }
  const unavailable = ids
    .map((id) => libraryById.get(id)!)
    .find((exercise) => !exercise.available);
  if (unavailable) {
    return {
      ok: false,
      reason: `${unavailable.name} is not available with your current equipment and constraints. Choose another variant.`,
    };
  }

  await markStepComplete(db, user, "routine", { routineDraft: parsed.data });
  revalidatePath("/setup");
  return { ok: true };
}

export type SetupRoutineBuildResponse =
  | {
      ok: true;
      draft: RoutineDraft;
      programName: string | null;
      warnings: string[];
      confidence: number;
    }
  | { ok: false; reason: string };

function programContextFromDocument(
  document: ProgramDocument,
  exerciseNames: Map<string, string>,
): RoutineBuildProgramContext {
  return {
    name: document.name,
    days: document.days.map((day) => {
      const groupNames = new Map(
        day.supersets.map((group) => [group.key, group.name]),
      );
      return {
        lineageId: day.lineageId,
        name: day.name,
        exercises: day.exercises.flatMap((exercise) => {
          const name = exerciseNames.get(exercise.exerciseId);
          return name
            ? [{
                exerciseId: exercise.exerciseId,
                name,
                sets: exercise.sets,
                repMin: exercise.repMin,
                repMax: exercise.repMax,
                restSec: exercise.restSec,
                group: exercise.supersetKey
                  ? groupNames.get(exercise.supersetKey) ?? "Grouped set"
                  : null,
              }]
            : [];
        }),
      };
    }),
  };
}

class RoutineBuildPartError extends Error {
  constructor(
    readonly part: string,
    readonly original: unknown,
  ) {
    super(`Routine build failed for ${part}.`);
    this.name = "RoutineBuildPartError";
  }
}

function routineBuildPartLabel(request: string): string {
  return /^(?:#{1,6}\s*)?(?:\*{1,2})?(?:ROUTINE TITLE:\s*)?(DAY\s+(?:\d+|[A-Z]))(?:\s*[:\u2014\u2013-].*)?(?:\*{1,2})?\s*$/im.exec(request)?.[1]
    ?? "this request";
}

function routineBuildFailureReason(error: RoutineBuildPartError): string {
  const original = error.original;
  const timedOut = original instanceof Error && (
    original.name === "TimeoutError"
    || /timed?\s*out|timeout/i.test(original.message)
  );
  return timedOut
    ? `Coach timed out while building ${error.part}. Try again; the other days do not need to be shortened.`
    : `Coach returned an unusable result for ${error.part}. Try again; if it repeats, submit that day by itself.`;
}

function draftExerciseFromBuild(
  ex: RoutineBuildExercise,
  exerciseName: string,
  warnings: string[],
  loadUnit: "lb" | "kg"
): RoutineDraft["days"][number]["exercises"][number] {
  let repMin = ex.repMin;
  let repMax = ex.repMax;
  if (repMax < repMin) {
    warnings.push(`${exerciseName}: rep range was reversed and has been corrected.`);
    [repMin, repMax] = [repMax, repMin];
  }

  return {
    exerciseId: ex.exerciseId,
    name: exerciseName,
    sets: ex.sets,
    repMin,
    repMax,
    targetLoad: ex.targetLoad,
    targetLoadUnit: ex.targetLoad == null ? null : loadUnit,
    restSec: snapRestSec(ex.restSec),
    supersetGroup: ex.supersetGroup?.trim() || null,
    notes: ex.notes?.trim() || null,
    warmup: ex.warmup
      ? {
          notes: ex.warmup.notes?.trim() || null,
          sets: ex.warmup.sets
            .map((set) => ({
              ...set,
              loadUnit: set.load == null ? null : loadUnit,
              label: set.label.trim(),
              loadText: set.loadText?.trim() || null,
              notes: set.notes?.trim() || null,
            }))
            .filter((set) => set.label.length > 0),
        }
      : null,
    setNotes: normalizeSetNotes(ex.setNotes, ex.sets),
  };
}

function uniqueNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of notes) {
    const normalized = note.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function routineWarmupText(
  exerciseName: string,
  warmup: RoutineWarmup | null,
): string[] {
  if (!warmup) return [];
  const lines: string[] = [];
  if (warmup.notes) lines.push(`${exerciseName}: ${warmup.notes}`);
  for (const set of warmup.sets) {
    const details = [
      set.reps == null ? null : `${set.reps} reps`,
      set.load == null ? null : `${set.load} ${set.loadUnit}`,
      set.loadPercent == null ? null : `${set.loadPercent}% of work weight`,
      set.loadText,
      set.notes,
    ].filter(Boolean);
    lines.push(
      `Before ${exerciseName}: ${set.label}${details.length ? ` — ${details.join(" · ")}` : ""}`,
    );
  }
  return lines;
}

/**
 * Setup routine build path: generate an editable draft from the user's free
 * text, profile, constraints, and available exercise library.
 */
async function buildRoutineDraft(
  input: string,
  scope: "setup" | "review",
  currentDocument?: ProgramDocument,
  activeDayId: string | null = null,
): Promise<SetupRoutineBuildResponse> {
  const text = z.string().min(1).max(20_000).parse(input).trim();
  if (!text) {
    return { ok: false, reason: "Describe the routine you want first." };
  }
  const user = await getCurrentUser();
  const db = await getDb();

  if (!isAIAvailable()) {
    return {
      ok: false,
      reason:
        "AI routine building isn't configured. Use the manual builder for now.",
    };
  }

  const [library, constraintRows] = await Promise.all([
    getLibraryWithAvailability(db, user.id),
    db.query.constraints.findMany({
      where: eq(constraintsTable.userId, user.id),
    }),
  ]);
  const avoidPatterns = new Set(
    constraintRows
      .filter((c) => c.avoid)
      .flatMap((c) => c.affectedPatterns)
  );
  const available = library.filter(
    (e) => e.available && !avoidPatterns.has(e.movementPattern)
  );
  if (!available.length) {
    return {
      ok: false,
      reason:
        "No available exercises were found for your equipment yet. Finish equipment setup first.",
    };
  }

  const buildContext = {
    profile: {
      experience: user.profile.experience,
      goals: user.profile.goals,
      weeklyFrequency: user.profile.weeklyFrequency,
      sessionLengthMin: user.profile.sessionLengthMin,
      unit: user.profile.unit,
    },
    constraints: constraintRows.map((c) => ({
      bodyPart: c.bodyPart,
      affectedPatterns: c.affectedPatterns,
      avoid: c.avoid,
      cautious: c.cautious,
      painStopThreshold: c.painStopThreshold,
      note: c.note,
    })),
    availableExercises: available.map((e) => ({
      exerciseId: e.id,
      name: e.name,
      movementPattern: e.movementPattern,
    })),
  };
  const currentProgram = currentDocument
    ? programContextFromDocument(
        currentDocument,
        new Map(library.map((exercise) => [exercise.id, exercise.name])),
      )
    : null;

  let envelopes: Array<AIEnvelope<RoutineBuildData>>;
  try {
    const requests = splitRoutineBuildRequests(text);
    const generatePart = async (request: string) => {
      const generateAttempt = async (attemptRequest: string) => {
        const buildInput = JSON.stringify({
          request: attemptRequest,
          ...buildContext,
          currentProgram: currentProgram
            ? routineBuildContextForRequest(
                attemptRequest,
                currentProgram,
                activeDayId,
              )
            : null,
        });
        const result = await runControlledStructuredGeneration(db, user.id, {
          task: "routine_build",
          system: ROUTINE_BUILD_SYSTEM,
          input: buildInput,
          schema: routineBuildSchema,
          deadlineMs: 110_000,
        });
        const envelope = result.value;
        await db.insert(aiParsingEvents).values({
          userId: user.id,
          scope,
          task: "routine_build",
          rawInput: buildInput,
          inputSha256: sensitiveTextSha256(buildInput),
          rawOutput: result.rawText,
          parsedJson: envelope,
          confidence: envelope.confidence,
          ambiguities: envelope.ambiguities,
          model: result.model,
          latencyMs: result.latencyMs,
          retentionExpiresAt: rawDataExpiresAt(),
        });
        return envelope;
      };

      const expectedNames = extractExplicitWorkExerciseNames(request);
      let envelope: AIEnvelope<RoutineBuildData>;
      try {
        envelope = await generateAttempt(request);
      } catch (error) {
        if (error instanceof AIUnavailableError || error instanceof AIControlError) {
          throw error;
        }
        throw new RoutineBuildPartError(routineBuildPartLabel(request), error);
      }
      const returnedExerciseCount = envelope.data.days.reduce(
        (total, day) => total + day.exercises.length,
        0
      );
      if (
        expectedNames.length > 0 &&
        (envelope.data.days.length !== 1 ||
          returnedExerciseCount !== expectedNames.length)
      ) {
        envelope = await generateAttempt(
          `${request}\n\nCORRECTION: The previous response returned ${returnedExerciseCount} work exercise objects. Return exactly ${expectedNames.length}, one for each item in the preservation checklist, in the same order, with no headings or warm-up sections represented as exercises.`
        );
      }
      return envelope;
    };
    envelopes = [];
    for (let index = 0; index < requests.length; index += 2) {
      envelopes.push(
        ...(await Promise.all(requests.slice(index, index + 2).map(generatePart))),
      );
    }
  } catch (err) {
    if (err instanceof AIUnavailableError) return { ok: false, reason: err.message };
    if (err instanceof AIControlError) return { ok: false, reason: err.message };
    if (err instanceof RoutineBuildPartError) {
      logDiagnosticEvent("ai.setup_routine_build_failed", {
        ...sanitizeAIProviderError(err.original),
      });
      return { ok: false, reason: routineBuildFailureReason(err) };
    }
    logDiagnosticEvent("ai.setup_routine_build_failed", {
      ...sanitizeAIProviderError(err),
    });
    return {
      ok: false,
      reason:
        "The routine builder had trouble with that. Try a shorter description or build manually.",
    };
  }

  const availableById = new Map(available.map((e) => [e.id, e]));
  const warnings = envelopes.flatMap((envelope) => [
    ...envelope.ambiguities.map((a) => a.issue),
    ...envelope.clarifyingQuestions,
    ...envelope.unparsed.map((fragment) => `Not used: ${fragment}`),
  ]);
  const draftDays: RoutineDraft["days"] = [];

  for (const day of envelopes.flatMap((envelope) => envelope.data.days)) {
    const exercisesForDay: RoutineDraft["days"][number]["exercises"] = [];
    for (const ex of day.exercises) {
      let libraryExercise = availableById.get(ex.exerciseId);
      const closestNameMatch = available
        .map((exercise) => ({
          exercise,
          score: exerciseNameSimilarity(ex.requestedName, exercise.name),
        }))
        .sort((a, b) => b.score - a.score)[0];
      const selectedScore = libraryExercise
        ? exerciseNameSimilarity(ex.requestedName, libraryExercise.name)
        : 0;
      if (
        closestNameMatch?.score >= 0.67 &&
        (!libraryExercise || closestNameMatch.score > selectedScore + 0.2)
      ) {
        if (libraryExercise && libraryExercise.id !== closestNameMatch.exercise.id) {
          warnings.push(
            `${ex.requestedName}: corrected ${libraryExercise.name} to ${closestNameMatch.exercise.name} from your exercise library.`
          );
        }
        libraryExercise = closestNameMatch.exercise;
      }
      if (!libraryExercise) {
        warnings.push(
          `${ex.requestedName}: unavailable or unknown exercise was skipped. Add or substitute it before saving.`
        );
        continue;
      }
      if (exerciseNameSimilarity(ex.requestedName, libraryExercise.name) < 0.67) {
        warnings.push(
          `${ex.requestedName}: mapped to ${libraryExercise.name}. Review this substitution before using the proposal.`
        );
      }
      exercisesForDay.push(
        draftExerciseFromBuild(
          { ...ex, exerciseId: libraryExercise.id },
          libraryExercise.name,
          warnings,
          user.profile.unit
        )
      );
    }
    if (exercisesForDay.length > 0) {
      const warmupLines = [
        day.warmupNotes?.trim() || null,
        ...exercisesForDay.flatMap((exercise) =>
          routineWarmupText(exercise.name, exercise.warmup),
        ),
      ].filter((line): line is string => Boolean(line));
      draftDays.push({
        name: day.name.trim() || `Day ${draftDays.length + 1}`,
        notes: day.notes?.trim() || null,
        warmupNotes: warmupLines.join("\n") || null,
        exercises: exercisesForDay.map((exercise) => ({
          ...exercise,
          warmup: null,
        })),
      });
    }
  }

  if (draftDays.length === 0) {
    return {
      ok: false,
      reason:
        "The routine builder responded, but no usable exercises matched your available library.",
    };
  }

  return {
    ok: true,
    draft: { days: draftDays },
    programName:
      envelopes
        .map((envelope) => envelope.data.programName?.trim())
        .find(Boolean) ?? null,
    warnings: uniqueNotes(warnings),
    confidence:
      envelopes.reduce((total, envelope) => total + envelope.confidence, 0) /
      envelopes.length,
  };
}

export async function buildSetupRoutineDraft(
  input: string,
): Promise<SetupRoutineBuildResponse> {
  return buildRoutineDraft(input, "setup");
}

export async function buildProgramRoutineDraft(
  input: string,
  currentDocument: ProgramDocument,
  activeDayId: string | null,
): Promise<SetupRoutineBuildResponse> {
  const parsedDocument = programDocumentSchema.safeParse(currentDocument);
  const parsedActiveDayId = z.string().uuid().nullable().safeParse(activeDayId);
  if (!parsedDocument.success || !parsedActiveDayId.success) {
    return {
      ok: false,
      reason: "The current Program changed before Coach could read it. Refresh and try again.",
    };
  }
  return buildRoutineDraft(
    input,
    "review",
    parsedDocument.data,
    parsedActiveDayId.data,
  );
}

// ---------------------------------------------------------------------------
// Step 5 — coaching preferences
// ---------------------------------------------------------------------------

const prefsSchema = z.object({
  aggressiveness: z.enum(["conservative", "moderate", "aggressive"]),
  deloadSuggestions: z.boolean(),
  substitutionSuggestions: z.boolean(),
  weeklyReview: z.boolean(),
});

export async function saveCoachingPrefs(
  input: z.infer<typeof prefsSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the preference values." };
  const user = await getCurrentUser();
  const db = await getDb();

  await db
    .update(userProfiles)
    .set({ coachingPrefs: parsed.data, updatedAt: new Date() })
    .where(eq(userProfiles.id, user.profile.id));
  await markStepComplete(db, user, "coaching");
  revalidatePath("/setup");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 6 — review & activate
// ---------------------------------------------------------------------------

/**
 * Turns the confirmed routine draft into ProgramVersion v1 (plan §4 step 6).
 * Archives any previously active program so exactly one is active.
 */
export async function activateSetupProgram(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const user = await getCurrentUser();
  const db = await getDb();

  // First-time setup activation is a one-time path. A completed account is
  // refused before any snapshot or Program work; real Program changes go
  // through the versioned Program editor instead.
  if (user.profile.setupCompletedAt != null) {
    return {
      ok: false,
      reason:
        "Setup is already complete, so this first-time activation no longer applies. Edit your Program through the Program page instead.",
    };
  }

  const draft = routineDraftSchema.safeParse(user.profile.setupState.routineDraft);
  if (!draft.success) {
    return { ok: false, reason: "Build your routine (step 4) before activating." };
  }

  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_program_activation",
    "Automatic protection created before replacing the active program from guided setup."
  );
  if (!safety.ok) {
    return {
      ok: false,
      reason: `The program was not changed because its safety snapshot could not be verified: ${safety.reason}`,
    };
  }

  const days = draft.data.days.map((day) => {
    const groupCounts = new Map<string, number>();
    for (const exercise of day.exercises) {
      if (exercise.supersetGroup) {
        groupCounts.set(
          exercise.supersetGroup,
          (groupCounts.get(exercise.supersetGroup) ?? 0) + 1
        );
      }
    }
    return {
      name: day.name,
      notes: day.notes ?? null,
      warmupNotes: day.warmupNotes ?? null,
      exercises: day.exercises.map((exercise) => ({
        exerciseId: exercise.exerciseId,
        sets: exercise.sets,
        repMin: exercise.repMin,
        repMax: exercise.repMax,
        targetLoad: exercise.targetLoad,
        restSec: exercise.restSec,
        supersetKey:
          exercise.supersetGroup &&
          (groupCounts.get(exercise.supersetGroup) ?? 0) >= 2
            ? exercise.supersetGroup
            : null,
        notes: exercise.notes,
        warmupNotes: exercise.warmup?.notes ?? null,
        warmupSets: exercise.warmup?.sets ?? [],
        setNotes: exercise.setNotes,
      })),
    };
  });
  const activated = await activateProgramAtomically(db, {
    userId: user.id,
    loadUnit: user.profile.unit,
    programName: "My program",
    days,
    changeSummary: "Created in guided setup",
    auditAction: "program.activate",
    auditSummary: "Program activated from guided setup with reviewed structured intent",
    expectedSetupDraft: user.profile.setupState.routineDraft,
    completeSetup: true,
    structuredIntentReviewed: true,
  });
  if (!activated.ok) return activated;

  revalidatePath("/today");
  revalidatePath("/program");
  return { ok: true };
}
