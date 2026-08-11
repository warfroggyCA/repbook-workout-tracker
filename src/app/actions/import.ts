"use server";

import { and, eq, sql } from "drizzle-orm";
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
  PROGRAM_INPUT_MAX_DAYS,
  programInputRequiresExactPerSetSupport,
  routineParseDraftSchema,
  type RoutineParseData,
} from "@/ai/tasks/routine-parse/schema";
import { normalizeRoutineParseDraftEnvelope } from "@/ai/tasks/routine-parse/normalize";
import { ROUTINE_PARSE_SYSTEM } from "@/ai/tasks/routine-parse/prompt";
import {
  CANONICAL_ROUTINE_PARSER_VERSION,
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
  buildRoutineImportStagePayload,
  readRoutineImportStagePayload,
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
import { getActiveProgramVersion } from "@/services/program";
import {
  programDayIntentSchema,
  programDayWarmupItemSchema,
  programSlotIntentSchema,
} from "@/lib/program-document";
import { canonicalJson } from "@/services/snapshot-crypto";
import { runExpensiveOperation } from "@/services/expensive-operations";
import { resultRows } from "@/db/result";

export type RoutineParseResponse =
  | {
      ok: true;
      importEventId: string;
      envelope: AIEnvelope<RoutineParseData>;
      /** One entry per distinct rawName across all days. */
      mappings: ImportMapping[];
      /** Full pickable library with equipment verdicts for the review table. */
      library: LibraryExerciseOption[];
      /** Binds confirmation to the exact staged package shown for review. */
      stageDigest: string;
      /** Active Program version observed when parsing began; null means none. */
      baseProgramVersionId: string | null;
    }
  | { ok: false; reason: string };

const routineTextSchema = z.string().trim().min(1).max(20_000);
const routineParseRequestSchema = z
  .object({
    text: routineTextSchema,
    clientImportId: z.string().uuid(),
  })
  .strict();

export type RoutineParseRequest = z.infer<typeof routineParseRequestSchema>;

async function routineParseSuccess(
  db: Db,
  userId: string,
  importEventId: string,
  payload: NonNullable<ReturnType<typeof readRoutineImportStagePayload>>,
): Promise<Extract<RoutineParseResponse, { ok: true }>> {
  const library = await getLibraryWithAvailability(db, userId);
  const mediaByExercise = await getApprovedExerciseMedia(db, library);
  return {
    ok: true,
    importEventId,
    envelope: payload.envelope,
    mappings: payload.mappings,
    library: library.map((exercise) => ({
      ...exercise,
      media: mediaByExercise.get(exercise.id) ?? null,
    })),
    stageDigest: payload.stageDigest,
    baseProgramVersionId: payload.baseProgramVersionId,
  };
}

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
  input: RoutineParseRequest,
): Promise<RoutineParseResponse> {
  const validated = routineParseRequestSchema.safeParse(input);
  if (!validated.success) {
    const text =
      input && typeof input === "object" && "text" in input
        ? input.text
        : null;
    return {
      ok: false,
      reason:
        typeof text === "string" && text.trim().length === 0
          ? "Paste a routine before parsing."
          : "Routine text must be 20,000 characters or fewer.",
    };
  }
  const { text, clientImportId } = validated.data;
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
  const payloadSha256 = sensitiveTextSha256(text);
  const activeAtParse = await getActiveProgramVersion(db, user.id);
  let baseProgramVersionId = activeAtParse?.version.id ?? null;
  // Stage the raw text first so a successful review has durable provenance.
  // The caller-generated identity makes network retries converge on this row.
  // Failed parses are immediately discarded by failRoutineParse below.
  let event: typeof importEvents.$inferSelect;
  try {
    const [stagedEvent] = await db
      .insert(importEvents)
      .values({
        id: clientImportId,
        userId: user.id,
        source: "paste",
        rawPayload: text,
        payloadSha256,
        parsedPayload: {
          schemaVersion: "routine-import-claim/1",
          baseProgramVersionId,
        },
        retentionExpiresAt: rawDataExpiresAt(),
      })
      .onConflictDoNothing({ target: importEvents.id })
      .returning();
    if (stagedEvent) {
      event = stagedEvent;
    } else {
      const existing = await db.query.importEvents.findFirst({
        where: and(
          eq(importEvents.id, clientImportId),
          eq(importEvents.userId, user.id),
          eq(importEvents.source, "paste"),
        ),
      });
      if (!existing || existing.payloadSha256 !== payloadSha256) {
        throw new Error("Routine import retry identity was reused");
      }
      const existingPayload = readRoutineImportStagePayload(
        existing.parsedPayload,
      );
      if (existing.status === "parsed" && existingPayload) {
        return routineParseSuccess(
          db,
          user.id,
          existing.id,
          existingPayload,
        );
      }
      if (existing.status === "confirmed") {
        return {
          ok: false,
          reason: "This paste was already published as a Program version.",
        };
      }
      if (existing.status === "discarded") {
        return {
          ok: false,
          reason:
            "This paste attempt was discarded. Retry it as a new review.",
        };
      }
      const claim = existing.parsedPayload as {
        schemaVersion?: unknown;
        baseProgramVersionId?: unknown;
      } | null;
      if (
        claim?.schemaVersion === "routine-import-claim/1" &&
        (claim.baseProgramVersionId === null ||
          typeof claim.baseProgramVersionId === "string")
      ) {
        baseProgramVersionId = claim.baseProgramVersionId;
      }
      if (Date.now() - existing.createdAt.getTime() < 3 * 60_000) {
        return {
          ok: false,
          reason:
            "This paste is still being parsed. Wait a moment, then retry without changing it.",
        };
      }
      event = existing;
    }
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
    if (programInputRequiresExactPerSetSupport(envelope.data)) {
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category: "unsupported_rep_sequence",
      });
    }
  } else {
    let result;
    try {
      result = await runControlledStructuredGeneration(db, user.id, {
        task: "routine_parse",
        system: ROUTINE_PARSE_SYSTEM,
        input: text,
        schema: routineParseDraftSchema,
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
    try {
      envelope = normalizeRoutineParseDraftEnvelope(result.value, text);
    } catch {
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category: "output_incomplete",
      });
    }
    if (programInputRequiresExactPerSetSupport(envelope.data)) {
      return failRoutineParse(db, {
        userId: user.id,
        importEventId: event.id,
        text,
        startedAt: parseStartedAt,
        category: "unsupported_rep_sequence",
      });
    }
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
    const stagedPayload = buildRoutineImportStagePayload({
      schemaVersion: "routine-import-stage/1",
      envelope,
      mappings,
      parserVersion,
      aiEventIds: { routineParse: parseEventId, exerciseMap: mapEventId },
      baseProgramVersionId,
    });
    const updatedEvents = await db
      .update(importEvents)
      .set({
        parsedPayload: stagedPayload,
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
    if (updatedEvents.length === 1) {
      return routineParseSuccess(db, user.id, event.id, stagedPayload);
    }
    const persisted = await db.query.importEvents.findFirst({
      where: and(
        eq(importEvents.id, event.id),
        eq(importEvents.userId, user.id),
        eq(importEvents.status, "parsed"),
      ),
    });
    const persistedPayload = readRoutineImportStagePayload(
      persisted?.parsedPayload,
    );
    if (persistedPayload) {
      return routineParseSuccess(db, user.id, event.id, persistedPayload);
    }
    throw new Error("Routine import was not available to stage for review");
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
    lineageId: z.string().uuid(),
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
    loadUnit: z.enum(["lb", "kg"]).nullable(),
    restSec: z.number().int().min(0).max(1800),
    supersetKey: z.string().trim().min(1).max(80).nullable(),
    notes: z.string().trim().min(1).max(2000).nullable(),
    intent: programSlotIntentSchema,
  })
  .strict()
  .superRefine((exercise, context) => {
    if (exercise.repMax < exercise.repMin) {
      context.addIssue({
        code: "custom",
        path: ["repMax"],
        message: "Maximum reps must be at least minimum reps.",
      });
    }
    if ((exercise.load == null) !== (exercise.loadUnit == null)) {
      context.addIssue({
        code: "custom",
        path: ["loadUnit"],
        message: "A measured load needs an explicit unit.",
      });
    }
    if (
      exercise.intent.minimumDose.unit !== "sets" ||
      exercise.intent.idealDose.unit !== "sets" ||
      exercise.intent.idealDose.value !== exercise.sets ||
      exercise.intent.minimumDose.value > exercise.sets
    ) {
      context.addIssue({
        code: "custom",
        path: ["intent", "idealDose"],
        message:
          "Shortened-session intent must use reviewed set minimums and the published set count as the full-session target.",
      });
    }
  });

const comparableInstruction = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/^warm[ -]?up\s*:\s*/u, "")
    .replace(/[\s.!]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const confirmDaySchema = z
  .object({
    lineageId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    warmupItems: z.array(programDayWarmupItemSchema).max(24),
    intent: programDayIntentSchema,
    exercises: z.array(confirmExerciseSchema).min(1).max(60),
  })
  .strict()
  .superRefine((day, context) => {
    const slotLineages = new Set(
      day.exercises.map((exercise) => exercise.lineageId),
    );
    if (slotLineages.size !== day.exercises.length) {
      context.addIssue({
        code: "custom",
        path: ["exercises"],
        message: "Exercise identities must be unique within a day.",
      });
    }
    const groupedExercises = new Map<string, typeof day.exercises>();
    for (const exercise of day.exercises) {
      if (!exercise.supersetKey) continue;
      const members = groupedExercises.get(exercise.supersetKey) ?? [];
      members.push(exercise);
      groupedExercises.set(exercise.supersetKey, members);
    }
    for (const [groupKey, members] of groupedExercises) {
      if (members.length < 2) {
        context.addIssue({
          code: "custom",
          path: ["exercises"],
          message: `Paired group ${groupKey} must retain at least two exercises or be cleared.`,
        });
      }
      if (new Set(members.map((member) => member.sets)).size > 1) {
        context.addIssue({
          code: "custom",
          path: ["exercises"],
          message: `Paired group ${groupKey} must use the same planned set count for every exercise or be cleared.`,
        });
      }
      if (
        new Set(members.slice(0, -1).map((member) => member.restSec)).size > 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["exercises"],
          message: `Paired group ${groupKey} must use one shared rest time before the next paired exercise.`,
        });
      }
    }
    for (const [index, item] of day.warmupItems.entries()) {
      if (
        item.beforeSlotLineageId &&
        !slotLineages.has(item.beforeSlotLineageId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["warmupItems", index, "beforeSlotLineageId"],
          message: "A lift ramp must refer to an exercise retained in this day.",
        });
      }
    }
    const warmupLabels = new Set(
      day.warmupItems.map((item) => comparableInstruction(item.label)),
    );
    for (const [index, exercise] of day.exercises.entries()) {
      if (!exercise.notes) continue;
      const fragments = exercise.notes
        .split(/[;\r\n]+/u)
        .map(comparableInstruction)
        .filter(Boolean);
      if (fragments.some((fragment) => warmupLabels.has(fragment))) {
        context.addIssue({
          code: "custom",
          path: ["exercises", index, "notes"],
          message:
            "A structured warm-up instruction cannot also be published as an exercise note.",
        });
      }
    }
  });

const confirmSchema = z
  .object({
    schemaVersion: z.literal("program-input-review/1"),
    importEventId: z.string().uuid(),
    stageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    baseProgramVersionId: z.string().uuid().nullable(),
    equipmentFitReviewed: z.literal(true),
    programName: z.string().trim().min(1).max(120),
    days: z.array(confirmDaySchema).min(1).max(PROGRAM_INPUT_MAX_DAYS),
  })
  .strict();

export type ConfirmImportInput = z.infer<typeof confirmSchema>;

async function readExactConfirmedImport(
  db: Db,
  userId: string,
  parsed: ConfirmImportInput,
): Promise<{ ok: true; programVersionId: string } | null> {
  const completed = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.id, parsed.importEventId),
      eq(importEvents.userId, userId),
    ),
  });
  if (
    completed?.status !== "confirmed" ||
    !completed.resultProgramVersionId ||
    canonicalJson(completed.confirmedPayload) !== canonicalJson(parsed)
  ) {
    return null;
  }
  return {
    ok: true,
    programVersionId: completed.resultProgramVersionId,
  };
}

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
  const validation = confirmSchema.safeParse(input);
  if (!validation.success) {
    return {
      ok: false,
      reason:
        "The reviewed Program has an invalid or incomplete field. Check every warm-up, exercise, and shortened-session choice.",
    };
  }
  const parsed = validation.data;
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation<
    | { ok: true; programVersionId: string }
    | { ok: false; reason: string }
  >(
    db,
    user.id,
    "import",
    async () => {

  const event = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.id, parsed.importEventId),
      eq(importEvents.userId, user.id)
    ),
  });
  if (!event) return { ok: false, reason: "Import not found." };
  if (event.status === "confirmed") {
    if (
      event.resultProgramVersionId &&
      canonicalJson(event.confirmedPayload) === canonicalJson(parsed)
    ) {
      return {
        ok: true,
        programVersionId: event.resultProgramVersionId,
      };
    }
    return {
      ok: false,
      reason: "This import was already published with different reviewed choices.",
    };
  }
  if (event.status !== "parsed")
    return { ok: false, reason: "This import isn't ready to confirm." };

  const stagedPayload = readRoutineImportStagePayload(event.parsedPayload);
  if (
    !stagedPayload ||
    stagedPayload.stageDigest !== parsed.stageDigest ||
    stagedPayload.baseProgramVersionId !== parsed.baseProgramVersionId
  ) {
    return {
      ok: false,
      reason:
        "This review no longer matches the staged paste. Discard it and parse again.",
    };
  }
  if (programInputRequiresExactPerSetSupport(stagedPayload.envelope.data)) {
    return {
      ok: false,
      reason:
        "This staged paste contains different rep targets for individual sets, which this importer cannot publish exactly. Nothing was published; discard it and rewrite each affected exercise as one exact target or range.",
    };
  }
  const stagedDays = stagedPayload.envelope.data.days;
  const stagedIdentityMatches =
    parsed.days.length === stagedDays.length &&
    parsed.days.every((day, dayIndex) => {
      const stagedDay = stagedDays[dayIndex];
      if (!stagedDay || day.lineageId !== stagedDay.lineageId) return false;
      const stagedSlotIndexes = new Map(
        stagedDay.exercises.map((exercise, index) => [exercise.lineageId, index]),
      );
      let previousIndex = -1;
      const seen = new Set<string>();
      return day.exercises.every((exercise) => {
        const stagedIndex = stagedSlotIndexes.get(exercise.lineageId);
        if (
          stagedIndex == null ||
          stagedIndex <= previousIndex ||
          seen.has(exercise.lineageId)
        ) {
          return false;
        }
        previousIndex = stagedIndex;
        seen.add(exercise.lineageId);
        return true;
      });
    });
  if (!stagedIdentityMatches) {
    return {
      ok: false,
      reason:
        "This review no longer matches the staged days and exercises. Nothing was published; discard it and parse again.",
    };
  }
  const currentProgram = await getActiveProgramVersion(db, user.id);
  if ((currentProgram?.version.id ?? null) !== parsed.baseProgramVersionId) {
    const duplicateResult = await readExactConfirmedImport(db, user.id, parsed);
    if (duplicateResult) return duplicateResult;
    return {
      ok: false,
      reason:
        "Your active Program changed after this review began. Nothing was published; discard this review and parse again against the current Program.",
    };
  }

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

  const aiEventIds = [
    stagedPayload.aiEventIds.routineParse,
    stagedPayload.aiEventIds.exerciseMap,
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
      return {
        lineageId: day.lineageId,
        name: day.name,
        warmupItems: day.warmupItems,
        intent: day.intent,
        exercises: day.exercises.map((exercise) => ({
          lineageId: exercise.lineageId,
          exerciseId: exercise.exerciseId,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetLoad: exercise.load,
          targetLoadUnit: exercise.loadUnit,
          restSec: exercise.restSec,
          supersetKey: exercise.supersetKey,
          notes: exercise.notes,
          intent: exercise.intent,
        })),
      };
    }),
    changeSummary: "Imported from pasted routine (confirmed in review)",
    auditAction: "import.confirm",
    auditSummary: `Program "${parsed.programName}" activated with reviewed structured intent from confirmed routine import (${parsed.days.length} day${parsed.days.length > 1 ? "s" : ""}, ${exerciseCount} exercises); previous version preserved`,
    importEventId: event.id,
    aiEventIds,
    confirmedPayload: parsed,
    expectedCurrentProgramVersionId: parsed.baseProgramVersionId,
    structuredIntentReviewed: true,
  });
  if (!activated.ok) {
    // Two identical deliveries can both finish validation before activation
    // serializes on the ImportEvent row. The winner stores the exact reviewed
    // receipt; the loser must converge on that same success without treating a
    // changed payload as idempotent.
    const duplicateResult = await readExactConfirmedImport(db, user.id, parsed);
    if (duplicateResult) return duplicateResult;
    return activated;
  }

  revalidatePath("/program");
  revalidatePath("/today");
  return { ok: true, programVersionId: activated.programVersionId };
    },
  );
  if (!controlled.ok) {
    const duplicateResult = await readExactConfirmedImport(db, user.id, parsed);
    if (duplicateResult) return duplicateResult;
    return { ok: false, reason: controlled.reason };
  }
  return controlled.value;
}

/** Review-screen "start over": the staged parse is kept but marked discarded. */
export async function discardImport(
  importEventId: string
): Promise<{ ok: boolean }> {
  const validated = z.string().uuid().safeParse(importEventId);
  if (!validated.success) return { ok: false };
  const id = validated.data;
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation(db, user.id, "import", async () => {
    const event = await db.query.importEvents.findFirst({
      where: and(
        eq(importEvents.id, id),
        eq(importEvents.userId, user.id),
      ),
    });
    if (!event) return { ok: false };
    if (event.status === "discarded") return { ok: true };
    if (event.status !== "parsed") return { ok: false };
    const staged = readRoutineImportStagePayload(event.parsedPayload);
    const aiEventIds = staged
      ? [staged.aiEventIds.routineParse, staged.aiEventIds.exerciseMap].filter(
          (aiEventId): aiEventId is string => Boolean(aiEventId),
        )
      : [];
    const [row] = resultRows(await db.execute(sql`
      WITH target_import AS MATERIALIZED (
        SELECT id
        FROM import_events
        WHERE id = ${id}::uuid
          AND user_id = ${user.id}::uuid
          AND status = 'parsed'
        FOR UPDATE
      ), redacted_ai_events AS (
        UPDATE ai_parsing_events
        SET raw_input = '',
            raw_output = NULL,
            parsed_json = NULL,
            ambiguities = '[]'::jsonb,
            raw_redacted_at = now(),
            retention_expires_at = NULL
        WHERE user_id = ${user.id}::uuid
          AND confirmed = false
          AND id IN (
            SELECT value::uuid
            FROM jsonb_array_elements_text(${JSON.stringify(aiEventIds)}::jsonb)
          )
          AND EXISTS (SELECT 1 FROM target_import)
        RETURNING id
      ), discarded_import AS (
        UPDATE import_events
        SET status = 'discarded',
            raw_payload = '',
            parsed_payload = NULL,
            raw_redacted_at = now(),
            retention_expires_at = NULL
        WHERE id IN (SELECT id FROM target_import)
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM discarded_import) AS imports,
        (SELECT count(*)::int FROM redacted_ai_events) AS ai_events
    `));
    return { ok: Number(row?.imports ?? 0) === 1 };
  });
  return controlled.ok ? controlled.value : { ok: false };
}
