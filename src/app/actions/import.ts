"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import {
  aiParsingEvents,
  constraints,
  importEvents,
  equipmentItems,
  plateInventory,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";
import { logDiagnosticEvent } from "@/lib/server-log";
import { audit } from "@/services/audit";
import { isAIAvailable, AIUnavailableError } from "@/ai/provider";
import type { AIEnvelope } from "@/ai/envelope";
import {
  routineParseSchema,
  type RoutineParseData,
} from "@/ai/tasks/routine-parse/schema";
import { ROUTINE_PARSE_SYSTEM } from "@/ai/tasks/routine-parse/prompt";
import {
  CANONICAL_ROUTINE_PARSER_VERSION,
  collectSupersetRoundRestSeconds,
  inspectRoutineTextStructure,
  parseCanonicalRoutineText,
} from "@/ai/tasks/routine-parse/deterministic";
import {
  exerciseMapSchema,
  type ExerciseMapRequest,
} from "@/ai/tasks/exercise-map/schema";
import { EXERCISE_MAP_SYSTEM } from "@/ai/tasks/exercise-map/prompt";
import { sanitizeExerciseMappings } from "@/ai/tasks/exercise-map/validate";
import { resolveExerciseName } from "@/services/exercise-map";
import {
  getLibraryWithAvailability,
  type ImportMapping,
  type LibraryExerciseOption,
} from "@/services/routine-import";
import {
  buildEquipmentAvailability,
  missingRequirements,
} from "@/engine/equipment-filter";
import { isPatternAllowedForSuggestions } from "@/engine/constraint-filter";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import { activateProgramAtomically } from "@/services/program-activation";
import { getApprovedExerciseMedia } from "@/services/exercise-media";
import {
  rawDataExpiresAt,
  sensitiveTextSha256,
} from "@/lib/privacy-retention";
import {
  AIControlError,
  runControlledStructuredGeneration,
} from "@/services/ai-control";
import {
  routineImportFailureCategory,
  routineImportFailureMessage,
  type RoutineImportFailureCategory,
} from "@/lib/routine-import-error";
import { discardFailedRoutineImport } from "@/services/routine-import-failure";

export type RoutineParseResponse =
  | {
      ok: true;
      importEventId: string;
      envelope: AIEnvelope<RoutineParseData>;
      /** One entry per distinct rawName across all days. */
      mappings: ImportMapping[];
      /** Full pickable library with equipment verdicts for the review table. */
      library: LibraryExerciseOption[];
    }
  | { ok: false; reason: string };

const routineTextSchema = z.string().trim().min(1).max(20_000);

function logRoutineParseFailure(
  text: string,
  startedAt: number,
  failureCategory: RoutineImportFailureCategory,
) {
  const structure = inspectRoutineTextStructure(text);
  logDiagnosticEvent("routine_import.parse_failed", {
    failureCategory,
    inputCharacterCount: structure.characterCount,
    detectedDayCount: structure.dayCount,
    detectedExerciseCount: structure.exerciseCount,
    durationMs: Math.min(1_000_000, Math.max(0, Date.now() - startedAt)),
  });
}

async function failRoutineParse(
  db: Db,
  input: {
    userId: string;
    importEventId: string;
    text: string;
    startedAt: number;
    category: RoutineImportFailureCategory;
    parsingEventIds?: readonly string[];
  },
): Promise<Extract<RoutineParseResponse, { ok: false }>> {
  let discarded = true;
  try {
    await discardFailedRoutineImport(
      db,
      input.userId,
      input.importEventId,
      input.parsingEventIds,
    );
  } catch {
    discarded = false;
  }
  const category = discarded ? input.category : "persistence_failure";
  logRoutineParseFailure(input.text, input.startedAt, category);
  return {
    ok: false,
    reason: discarded
      ? routineImportFailureMessage(category)
      : "Your current Program was not changed. Repbook could not immediately discard the failed paste; automatic privacy retention will remove it. Retry later.",
  };
}

/**
 * Plan §5 pipeline, first two states: ImportEvent(raw) → parsed. Contract 3
 * (routine_parse) runs first with rawNames verbatim; contract 4
 * (exercise_map) then chooses ONLY among deterministic candidates from
 * resolveExerciseName. Nothing touches program tables here — that requires
 * confirmImport.
 */
export async function parseRoutineText(
  input: string
): Promise<RoutineParseResponse> {
  const validated = routineTextSchema.safeParse(input);
  if (!validated.success) {
    return {
      ok: false,
      reason:
        typeof input === "string" && input.trim().length === 0
          ? "Paste a routine before parsing."
          : "Routine text must be 20,000 characters or fewer.",
    };
  }
  const text = validated.data;
  const deterministicEnvelope = parseCanonicalRoutineText(text);
  const user = await getCurrentUser();
  const db = await getDb();

  if (!deterministicEnvelope && !isAIAvailable()) {
    return {
      ok: false,
      reason:
        "Free-form AI parsing isn't configured. Use canonical Day and exercise lines with sets x reps and rest, or edit the Program manually.",
    };
  }

  const parseStartedAt = Date.now();
  // Stage the raw text first so a successful review has durable provenance.
  // Failed parses are immediately discarded by failRoutineParse below.
  let event: typeof importEvents.$inferSelect;
  try {
    const [stagedEvent] = await db
      .insert(importEvents)
      .values({
        userId: user.id,
        source: "paste",
        rawPayload: text,
        payloadSha256: sensitiveTextSha256(text),
        retentionExpiresAt: rawDataExpiresAt(),
      })
      .returning();
    if (!stagedEvent) throw new Error("Routine import was not staged");
    event = stagedEvent;
  } catch {
    logRoutineParseFailure(text, parseStartedAt, "persistence_failure");
    return {
      ok: false,
      reason:
        "Your current Program was not changed, and the paste was not retained. Repbook could not safely stage the routine for review. Retry later.",
    };
  }

  let envelope: AIEnvelope<RoutineParseData>;
  let parseEventId: string | null = null;
  let parserVersion: string;
  if (deterministicEnvelope) {
    envelope = deterministicEnvelope;
    parserVersion = CANONICAL_ROUTINE_PARSER_VERSION;
  } else {
    let result;
    try {
      result = await runControlledStructuredGeneration(db, user.id, {
        task: "routine_parse",
        system: ROUTINE_PARSE_SYSTEM,
        input: text,
        schema: routineParseSchema,
        deadlineMs: 90_000,
      });
    } catch (error) {
      const sanitized = sanitizeAIProviderError(error);
      const category =
        error instanceof AIUnavailableError
          ? "provider_failure"
          : error instanceof AIControlError
            ? "usage_control"
            : routineImportFailureCategory(sanitized.errorKind);
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category,
      });
    }
    envelope = result.value;
    parserVersion = "ai-structured-output/1";
    if (!envelope.data.days.some((day) => day.exercises.length > 0)) {
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category: "output_incomplete",
      });
    }
    try {
      const [row] = await db
        .insert(aiParsingEvents)
        .values({
          userId: user.id,
          scope: "import",
          task: "routine_parse",
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
      parseEventId = row.id;
    } catch {
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category: "persistence_failure",
      });
    }
  }

  // Deterministic tier of contract 4: exact → alias → fuzzy candidates.
  const rawNames = [
    ...new Set(
      envelope.data.days.flatMap((d) => d.exercises.map((e) => e.rawName))
    ),
  ];
  const mappingByRaw = new Map<string, ImportMapping>();
  const mapRequest: ExerciseMapRequest = [];
  try {
    for (const rawName of rawNames) {
      const res = await resolveExerciseName(db, rawName, user.id);
      mappingByRaw.set(rawName, {
        rawName,
        exerciseId: res.exerciseId,
        exerciseName: res.exerciseName,
        matchType: res.matchType,
        candidates: res.candidates,
      });
      if (res.matchType === "none" && res.candidates.length > 0) {
        mapRequest.push({
          rawName,
          candidates: res.candidates.map((candidate) => ({
            exerciseId: candidate.id,
            name: candidate.name,
          })),
        });
      }
    }
  } catch {
    return failRoutineParse(db, {
      userId: user.id,
      importEventId: event.id,
      text,
      startedAt: parseStartedAt,
      category: "persistence_failure",
      parsingEventIds: parseEventId ? [parseEventId] : [],
    });
  }

  // AI tier of contract 4 — batch, candidates only. A failure here degrades
  // gracefully: rows stay "none" and the user picks manually in review.
  let mapEventId: string | null = null;
  if (mapRequest.length > 0) {
    try {
      const mapInput = JSON.stringify(mapRequest);
      const result = await runControlledStructuredGeneration(db, user.id, {
        task: "exercise_map",
        system: EXERCISE_MAP_SYSTEM,
        input: mapInput,
        schema: exerciseMapSchema,
      });
      const { mappings, violations } = sanitizeExerciseMappings(
        result.value.data.mappings,
        mapRequest
      );
      const [row] = await db
        .insert(aiParsingEvents)
        .values({
          userId: user.id,
          scope: "import",
          task: "exercise_map",
          rawInput: mapInput,
          inputSha256: sensitiveTextSha256(mapInput),
          rawOutput: result.rawText,
          parsedJson: { envelope: result.value, sanitized: mappings, violations },
          confidence: result.value.confidence,
          ambiguities: result.value.ambiguities,
          model: result.model,
          latencyMs: result.latencyMs,
          retentionExpiresAt: rawDataExpiresAt(),
        })
        .returning();
      mapEventId = row.id;
      if (violations.length > 0) {
        // Provider-quality event (plan §5): the model broke the
        // candidates-only contract; the offending IDs were nulled out.
        await audit(db, {
          userId: user.id,
          actorType: "system",
          action: "ai.contract_violation",
          entityType: "ai_parsing_event",
          entityId: row.id,
          summary: `exercise_map violated the candidates-only contract ${violations.length}× (sanitized)`,
          causeRef: { violations },
        });
      }
      for (const m of mappings) {
        const base = mappingByRaw.get(m.rawName);
        if (!base) continue;
        const whyById = new Map(m.altCandidates.map((a) => [a.exerciseId, a.why]));
        mappingByRaw.set(m.rawName, {
          ...base,
          exerciseId: m.exerciseId,
          exerciseName:
            base.candidates.find((c) => c.id === m.exerciseId)?.name ?? null,
          matchType: m.matchType,
          candidates: base.candidates.map((c) => ({
            ...c,
            why: whyById.get(c.id),
          })),
        });
      }
    } catch (error) {
      // Deterministic candidates are already in place; review handles the rest.
      logDiagnosticEvent("routine_import.exercise_map_degraded", {
        candidateCount: mapRequest.length,
        ...sanitizeAIProviderError(error),
      });
    }
  }

  try {
    const mappings = rawNames.map((rawName) => mappingByRaw.get(rawName)!);
    const library = await getLibraryWithAvailability(db, user.id);
    const mediaByExercise = await getApprovedExerciseMedia(db, library);
    const routineLibrary = library.map((exercise) => ({
      ...exercise,
      media: mediaByExercise.get(exercise.id) ?? null,
    }));
    const updatedEvents = await db
      .update(importEvents)
      .set({
        parsedPayload: {
          envelope,
          mappings,
          parserVersion,
          aiEventIds: { routineParse: parseEventId, exerciseMap: mapEventId },
        },
        status: "parsed",
      })
      .where(
        and(
          eq(importEvents.id, event.id),
          eq(importEvents.userId, user.id),
          eq(importEvents.status, "raw"),
        ),
      )
      .returning({ id: importEvents.id });
    if (updatedEvents.length !== 1) {
      throw new Error("Routine import was not available to stage for review");
    }

    return {
      ok: true,
      importEventId: event.id,
      envelope,
      mappings,
      library: routineLibrary,
    };
  } catch {
    return failRoutineParse(db, {
      userId: user.id,
      importEventId: event.id,
      text,
      startedAt: parseStartedAt,
      category: "persistence_failure",
      parsingEventIds: [parseEventId, mapEventId].filter(
        (id): id is string => Boolean(id),
      ),
    });
  }
}

const confirmExerciseSchema = z
  .object({
    exerciseId: z.string().uuid(),
    sets: z.number().int().min(1).max(20),
    repMin: z.number().int().min(1).max(100),
    repMax: z.number().int().min(1).max(100),
    load: z
      .number()
      .finite()
      .min(0)
      .max(MAX_STORED_LOAD)
      .transform(normalizeStoredLoad)
      .nullable(),
    restSec: z.number().int().min(0).max(1800),
    supersetKey: z.string().min(1).max(20).nullable(),
    notes: z.string().max(500).nullable(),
  })
  .refine((e) => e.repMax >= e.repMin, {
    message: "repMax must be ≥ repMin",
  });

const confirmSchema = z.object({
  importEventId: z.string().uuid(),
  programName: z.string().min(1).max(120),
  days: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        exercises: z.array(confirmExerciseSchema).min(1),
      })
    )
    .min(1)
    .max(14),
});

export type ConfirmImportInput = z.infer<typeof confirmSchema>;

/**
 * The confirmation gate (plan §5/§13): the ONLY writer of imported program
 * data. Server re-validates everything the review table promised — every
 * exercise exists and is equipment-legal — then creates
 * Program → ProgramVersion → WorkoutTemplates → ExercisePrescriptions and
 * moves the ImportEvent to `confirmed`.
 */
export async function confirmImport(
  input: ConfirmImportInput
): Promise<{ ok: true; programVersionId: string } | { ok: false; reason: string }> {
  const parsed = confirmSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();

  const event = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.id, parsed.importEventId),
      eq(importEvents.userId, user.id)
    ),
  });
  if (!event) return { ok: false, reason: "Import not found." };
  if (event.status === "confirmed")
    return { ok: false, reason: "This import was already confirmed." };
  if (event.status !== "parsed")
    return { ok: false, reason: "This import isn't ready to confirm." };

  // Re-validate mappings: every exercise must exist, be visible to this
  // user, and pass the equipment filter. Client state is not trusted.
  const exerciseIds = [
    ...new Set(parsed.days.flatMap((d) => d.exercises.map((e) => e.exerciseId))),
  ];
  const [exerciseRows, equipmentRows, plateRows, constraintRows] = await Promise.all([
    db.query.exercises.findMany({
      where: (t, { inArray }) => inArray(t.id, exerciseIds),
      with: { equipmentRequirements: true },
    }),
    db.query.equipmentItems.findMany({
      where: eq(equipmentItems.userId, user.id),
    }),
    db.query.plateInventory.findMany({
      where: eq(plateInventory.userId, user.id),
      columns: { denomination: true },
    }),
    db.query.constraints.findMany({
      where: eq(constraints.userId, user.id),
    }),
  ]);
  const inventory = buildEquipmentAvailability(equipmentRows, plateRows);
  const exerciseById = new Map(exerciseRows.map((e) => [e.id, e]));
  for (const id of exerciseIds) {
    const ex = exerciseById.get(id);
    if (!ex || (ex.userId != null && ex.userId !== user.id)) {
      return { ok: false, reason: "An exercise in the import no longer exists." };
    }
    const missing = missingRequirements(ex.equipmentRequirements, inventory);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${ex.name} requires ${missing
          .map((m) => m.equipmentType.replace(/_/g, " "))
          .join(", ")} — not in your inventory. Substitute or remove it.`,
      };
    }
    if (!isPatternAllowedForSuggestions(ex.movementPattern, constraintRows)) {
      return {
        ok: false,
        reason: `${ex.name} is blocked by your current movement constraints. Substitute or remove it.`,
      };
    }
  }

  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_program_import",
    `Automatic protection created before activating imported program ${parsed.programName}.`
  );
  if (!safety.ok) {
    return {
      ok: false,
      reason: `The program was not changed because its safety snapshot could not be verified: ${safety.reason}`,
    };
  }

  const payload = event.parsedPayload as {
    aiEventIds?: { routineParse?: string | null; exerciseMap?: string | null };
  } | null;
  const aiEventIds = [
    payload?.aiEventIds?.routineParse,
    payload?.aiEventIds?.exerciseMap,
  ].filter((id): id is string => Boolean(id));
  const exerciseCount = parsed.days.reduce(
    (count, day) => count + day.exercises.length,
    0
  );
  const activated = await activateProgramAtomically(db, {
    userId: user.id,
    loadUnit: user.profile.unit,
    programName: parsed.programName,
    days: parsed.days.map((day) => {
      const supersetRoundRest = collectSupersetRoundRestSeconds(day.exercises);
      return {
        name: day.name,
        exercises: day.exercises.map((exercise) => ({
          exerciseId: exercise.exerciseId,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetLoad: exercise.load,
          restSec: exercise.restSec,
          supersetKey: exercise.supersetKey,
          supersetRestAfterRoundSec: exercise.supersetKey
            ? supersetRoundRest.get(exercise.supersetKey)
            : undefined,
          notes: exercise.notes,
        })),
      };
    }),
    changeSummary: "Imported from pasted routine (confirmed in review)",
    auditAction: "import.confirm",
    auditSummary: `Program "${parsed.programName}" activated with reviewed structured intent from confirmed routine import (${parsed.days.length} day${parsed.days.length > 1 ? "s" : ""}, ${exerciseCount} exercises); previous version preserved`,
    importEventId: event.id,
    aiEventIds,
    confirmedPayload: parsed,
    structuredIntentReviewed: true,
  });
  if (!activated.ok) return activated;

  revalidatePath("/program");
  revalidatePath("/today");
  return { ok: true, programVersionId: activated.programVersionId };
}

/** Review-screen "start over": the staged parse is kept but marked discarded. */
export async function discardImport(
  importEventId: string
): Promise<{ ok: boolean }> {
  const id = z.string().uuid().parse(importEventId);
  const user = await getCurrentUser();
  const db = await getDb();
  await db
    .update(importEvents)
    .set({
      status: "discarded",
      rawPayload: "",
      parsedPayload: null,
      rawRedactedAt: new Date(),
      retentionExpiresAt: null,
    })
    .where(
      and(
        eq(importEvents.id, id),
        eq(importEvents.userId, user.id),
        eq(importEvents.status, "parsed")
      )
    );
  return { ok: true };
}
