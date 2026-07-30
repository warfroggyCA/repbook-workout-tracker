import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import {
  programVersions,
  programs,
  supersetGroups,
} from "@/db/schema";
import {
  legacyProgramDocumentSchema,
  isIntentBearingProgramDocument,
  normalizeLegacyProgramWarmupSet,
  projectIntentProgramDocumentV2,
  programDocumentSchema,
  programDocumentV3Schema,
  type StoredProgramDocument,
} from "@/lib/program-document";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import { getTemplatesWithSlots } from "@/services/program";
import { hashProgramDocument } from "@/services/program-document-hash";
import {
  programPreflightResultSchema,
  runProgramPreflight,
  type ProgramPreflightResult,
  type ProgramPreflightContext,
} from "@/lib/program-preflight";
import type {
  ProgramReview,
  ProgramReviewChange,
} from "@/lib/program-review-contract";
import { loadProgramPreflightContext } from "@/services/program-preflight";

export type { ProgramReview, ProgramReviewChange };

export type ProgramReviewContext = {
  recommendationRevision?: number;
  recommendationConsequences?: ProgramReview["recommendationConsequences"];
  exercises?: Record<string, { name: string; primaryMuscles: string[] }>;
  preflightContext?: ProgramPreflightContext;
  basePublicationPreflight?: ProgramPreflightResult | null;
  nextPublicationPreflight?: ProgramPreflightResult | null;
};

function exposureSummary(
  preflight: ProgramPreflightResult | null | undefined,
  codes: Set<string>,
) {
  if (!preflight) return "Not recorded for this version";
  return preflight.findings
    .filter((finding) => codes.has(finding.code))
    .map((finding) => ({
      severity: finding.severity,
      reason: finding.reason,
      evidenceCount: finding.evidenceCount,
      dayLineageId: finding.dayLineageId,
      slotLineageId: finding.slotLineageId,
    }));
}

function emptySummary(): ProgramReview["summary"] {
  return {
    weeklySetsBefore: 0,
    weeklySetsAfter: 0,
    durationBefore: [],
    durationAfter: [],
    muscleSetsBefore: {},
    muscleSetsAfter: {},
  };
}

function programSummary(
  document: StoredProgramDocument,
  exercises: NonNullable<ProgramReviewContext["exercises"]>
) {
  let weeklySets = 0;
  const muscleSets: Record<string, number> = {};
  for (const day of document.days) {
    for (const slot of day.exercises) {
      weeklySets += slot.sets;
      for (const muscle of exercises[slot.exerciseId]?.primaryMuscles ?? []) {
        muscleSets[muscle] = (muscleSets[muscle] ?? 0) + slot.sets;
      }
    }
  }
  const duration = isIntentBearingProgramDocument(document)
    ? runProgramPreflight(projectIntentProgramDocumentV2(document)).durations
    : [];
  return { weeklySets, duration, muscleSets };
}

export async function getOwnedProgramVersionDocument(
  db: Db,
  userId: string,
  versionId: string
): Promise<StoredProgramDocument | null> {
  const version = await db.query.programVersions.findFirst({
    where: eq(programVersions.id, versionId),
    with: { program: true },
  });
  if (!version || version.program.userId !== userId) return null;

  const days = await getTemplatesWithSlots(db, version.id);
  const templateIds = days.map(({ template }) => template.id);
  const groups = templateIds.length
    ? await db.query.supersetGroups.findMany({
        where: inArray(supersetGroups.workoutTemplateId, templateIds),
        orderBy: supersetGroups.orderIdx,
      })
    : [];
  const groupsByTemplate = new Map<string, typeof groups>();
  for (const group of groups) {
    const bucket = groupsByTemplate.get(group.workoutTemplateId) ?? [];
    bucket.push(group);
    groupsByTemplate.set(group.workoutTemplateId, bucket);
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));

  const schemaVersion = version.documentSchemaVersion;
  const hasIntent = schemaVersion >= 2;
  const isV3 = schemaVersion === 3;
  const document = {
    schemaVersion: String(schemaVersion),
    programId: version.programId,
    baseVersionId: version.id,
    name: version.name,
    days: days.map(({ template, slots }) => ({
      lineageId: template.lineageId,
      name: template.name,
      notes: template.notes,
      warmupNotes: template.warmupNotes,
      ...(isV3 ? { warmupItems: template.warmupItems } : {}),
      ...(hasIntent ? { intent: template.intent } : {}),
      supersets: (groupsByTemplate.get(template.id) ?? []).map((group) => ({
        key: group.lineageId,
        name: group.name,
        restAfterRoundSec: group.restAfterRoundSec,
        ...(isV3 ? {
          structureStatus: group.plannedRounds == null
            ? "legacy_unequal" as const
            : "canonical" as const,
          plannedRounds: group.plannedRounds,
          restBetweenMembersSec: group.restBetweenMembersSec ?? 0,
          restBetweenRoundsSec: group.restAfterRoundSec,
        } : {}),
      })),
      exercises: slots.map(({ slot, prescription }) => {
        if (!prescription) {
          throw new Error("A Program exercise is missing its current targets.");
        }
        const setNotes = Array.from(
          { length: prescription.sets },
          (_, index) => slot.setNotes[index] ?? null
        );
        const group = slot.supersetGroupId
          ? groupById.get(slot.supersetGroupId)
          : null;
        return {
          lineageId: slot.lineageId,
          exerciseId: slot.exerciseId,
          sets: prescription.sets,
          repMin: prescription.repRangeMin,
          repMax: prescription.repRangeMax,
          targetLoad: prescription.targetLoad,
          targetLoadUnit: prescription.targetLoadUnit,
          progressionRuleId: prescription.progressionRuleId,
          restSec: slot.restSec,
          supersetKey: group?.lineageId ?? null,
          ...(isV3 ? { groupMemberOrderIdx: slot.groupMemberOrderIdx } : {}),
          notes: slot.notes,
          warmupNotes: slot.warmupNotes,
          warmupSets: slot.warmupSets.map((set) =>
            normalizeLegacyProgramWarmupSet(set),
          ),
          setNotes,
          ...(hasIntent ? { intent: slot.intent } : {}),
        };
      }),
    })),
  };
  if (isV3) return programDocumentV3Schema.parse(document);
  return hasIntent
    ? programDocumentSchema.parse(document)
    : legacyProgramDocumentSchema.parse(document);
}

export async function getCurrentProgramDocument(db: Db, userId: string) {
  const program = await db.query.programs.findFirst({
    where: and(
      eq(programs.userId, userId),
      eq(programs.status, "active")
    ),
  });
  if (!program?.currentVersionId || program.archivedAt) return null;
  return getOwnedProgramVersionDocument(db, userId, program.currentVersionId);
}

function preflightFindingIdentity(
  finding: ProgramPreflightResult["findings"][number],
) {
  return canonicalJson({
    code: finding.code,
    severity: finding.severity,
    reason: finding.reason,
    dayLineageId: finding.dayLineageId,
    slotLineageId: finding.slotLineageId,
    evidenceCount: finding.evidenceCount,
  });
}

export async function getCurrentProgramPreflightStatus(db: Db, userId: string) {
  const program = await db.query.programs.findFirst({
    where: and(eq(programs.userId, userId), eq(programs.status, "active")),
    with: { currentVersion: true },
  });
  if (!program?.currentVersionId || program.archivedAt || !program.currentVersion) {
    return null;
  }
  const document = await getOwnedProgramVersionDocument(
    db,
    userId,
    program.currentVersionId,
  );
  if (!document || !isIntentBearingProgramDocument(document)) {
    return {
      availability: "legacy" as const,
      publication: null,
      current: null,
      addedFindings: [],
      resolvedFindings: [],
      durationChangedDayLineageIds: [],
    };
  }
  const publicationResult = programPreflightResultSchema.safeParse(
    program.currentVersion.publicationPreflight,
  );
  const publication = publicationResult.success ? publicationResult.data : null;
  const preflightDocument = projectIntentProgramDocumentV2(document);
  const current = runProgramPreflight(
    preflightDocument,
    await loadProgramPreflightContext(db, userId, preflightDocument),
  );
  const publicationFindingKeys = new Set(
    publication?.findings.map(preflightFindingIdentity) ?? [],
  );
  const currentFindingKeys = new Set(current.findings.map(preflightFindingIdentity));
  const publicationDurations = new Map(
    publication?.durations.map((duration) => [duration.dayLineageId, duration]) ?? [],
  );

  return {
    availability: publication ? ("available" as const) : ("unavailable" as const),
    publication,
    current,
    addedFindings: current.findings.filter(
      (finding) => !publicationFindingKeys.has(preflightFindingIdentity(finding)),
    ),
    resolvedFindings:
      publication?.findings.filter(
        (finding) => !currentFindingKeys.has(preflightFindingIdentity(finding)),
      ) ?? [],
    durationChangedDayLineageIds: current.durations
      .filter((duration) => {
        const before = publicationDurations.get(duration.dayLineageId);
        return before == null || canonicalJson(before) !== canonicalJson(duration);
      })
      .map((duration) => duration.dayLineageId),
  };
}

function comparableTargets(slot: StoredProgramDocument["days"][number]["exercises"][number]) {
  return {
    sets: slot.sets,
    repMin: slot.repMin,
    repMax: slot.repMax,
    targetLoad: slot.targetLoad,
    targetLoadUnit: slot.targetLoadUnit,
    progressionRuleId: slot.progressionRuleId,
  };
}

function comparableDetails(slot: StoredProgramDocument["days"][number]["exercises"][number]) {
  return {
    restSec: slot.restSec,
    supersetKey: slot.supersetKey,
    notes: slot.notes,
    warmupNotes: slot.warmupNotes,
    warmupSets: slot.warmupSets,
    setNotes: slot.setNotes,
  };
}

export function reviewProgramDocuments(
  baseValue: unknown,
  nextValue: unknown,
  revision: number,
  context: ProgramReviewContext = {}
): ProgramReview {
  const recommendationRevision = context.recommendationRevision ?? 0;
  const recommendationConsequences = context.recommendationConsequences ?? [];
  const exerciseInfo = context.exercises ?? {};
  const exerciseName = (id: string) => exerciseInfo[id]?.name ?? "Exercise";
  const baseResult = legacyProgramDocumentSchema
    .or(programDocumentSchema)
    .or(programDocumentV3Schema)
    .safeParse(baseValue);
  if (!baseResult.success) throw baseResult.error;
  const base = baseResult.data;
  const nextResult = legacyProgramDocumentSchema
    .or(programDocumentSchema)
    .or(programDocumentV3Schema)
    .safeParse(nextValue);
  if (!nextResult.success) {
    const blockingErrors = nextResult.error.issues.map((issue) =>
      `${issue.path.join(".") || "Program"}: ${issue.message}`
    );
    return {
      status: "blocked",
      hash: null,
      reviewedRevision: revision,
      changes: [],
      blockingErrors,
      cautions: [],
      preflight: null,
      recommendationRevision,
      recommendationConsequences,
      summary: emptySummary(),
    };
  }
  const next = nextResult.data;
  const changes: ProgramReviewChange[] = [];
  const cautions: string[] = [];
  if (base.programId !== next.programId || base.baseVersionId !== next.baseVersionId) {
    return {
      status: "blocked",
      hash: null,
      reviewedRevision: revision,
      changes: [],
      blockingErrors: ["The draft no longer belongs to its original Program version."],
      cautions: [],
      preflight: null,
      recommendationRevision,
      recommendationConsequences,
      summary: emptySummary(),
    };
  }
  if (base.name !== next.name) {
    changes.push({ kind: "rename", path: "name", label: "Program name", before: base.name, after: next.name });
  }
  const baseDays = new Map(base.days.map((day, index) => [day.lineageId, { day, index }]));
  const nextDays = new Map(next.days.map((day, index) => [day.lineageId, { day, index }]));
  const baseSlotLocations = new Map(base.days.flatMap((day, dayIndex) =>
    day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex, day, dayIndex }] as const)
  ));
  const nextSlotLocations = new Map(next.days.flatMap((day, dayIndex) =>
    day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex, day, dayIndex }] as const)
  ));
  const handledAddedSlots = new Set<string>();
  for (const [lineageId, { day, index }] of baseDays) {
    const current = nextDays.get(lineageId);
    if (!current) {
      changes.push({ kind: "remove", path: `days.${lineageId}`, label: `Remove ${day.name}`, before: day.name, after: null });
      continue;
    }
    if (day.name !== current.day.name) {
      changes.push({ kind: "rename", path: `days.${lineageId}.name`, label: "Day name", before: day.name, after: current.day.name });
    }
    if (index !== current.index) {
      changes.push({ kind: "reorder", path: `days.${lineageId}`, label: current.day.name, before: index + 1, after: current.index + 1 });
    }
    if (day.notes !== current.day.notes || day.warmupNotes !== current.day.warmupNotes || canonicalJson(day.supersets) !== canonicalJson(current.day.supersets)) {
      changes.push({ kind: "details", path: `days.${lineageId}.details`, label: `${current.day.name} details`, before: { notes: day.notes, warmupNotes: day.warmupNotes, supersets: day.supersets }, after: { notes: current.day.notes, warmupNotes: current.day.warmupNotes, supersets: current.day.supersets } });
    }
    const previousDayIntent = "intent" in day ? day.intent : null;
    const currentDayIntent = "intent" in current.day ? current.day.intent : null;
    if (canonicalJson(previousDayIntent) !== canonicalJson(currentDayIntent)) {
      changes.push({
        kind: "intent",
        path: `days.${lineageId}.intent`,
        label: `${current.day.name} training intent`,
        before: previousDayIntent ?? "Not recorded in this historical version",
        after: currentDayIntent ?? "Not recorded in this historical version",
      });
    }
    const baseSlots = new Map(day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex }]));
    const nextSlots = new Map(current.day.exercises.map((slot, slotIndex) => [slot.lineageId, { slot, slotIndex }]));
    for (const [slotLineage, previous] of baseSlots) {
      const currentSlot = nextSlots.get(slotLineage);
      if (!currentSlot) {
        const moved = nextSlotLocations.get(slotLineage);
        if (moved) {
          changes.push({ kind: "reorder", path: `slots.${slotLineage}.day`, label: `Move ${exerciseName(previous.slot.exerciseId)}`, before: day.name, after: moved.day.name });
          if (canonicalJson(comparableTargets(previous.slot)) !== canonicalJson(comparableTargets(moved.slot))) {
            changes.push({ kind: "targets", path: `slots.${slotLineage}.targets`, label: `${exerciseName(moved.slot.exerciseId)} targets`, before: comparableTargets(previous.slot), after: comparableTargets(moved.slot) });
          }
          if (canonicalJson(comparableDetails(previous.slot)) !== canonicalJson(comparableDetails(moved.slot))) {
            changes.push({ kind: "details", path: `slots.${slotLineage}.details`, label: `${exerciseName(moved.slot.exerciseId)} details`, before: comparableDetails(previous.slot), after: comparableDetails(moved.slot) });
          }
          continue;
        }
        const replacement = current.day.exercises[previous.slotIndex];
        if (replacement && !baseSlotLocations.has(replacement.lineageId)) {
          handledAddedSlots.add(replacement.lineageId);
          changes.push({ kind: "replace", path: `slots.${slotLineage}.exerciseId`, label: `Replace ${exerciseName(previous.slot.exerciseId)} with ${exerciseName(replacement.exerciseId)}`, before: exerciseName(previous.slot.exerciseId), after: exerciseName(replacement.exerciseId) });
          continue;
        }
        changes.push({ kind: "remove", path: `slots.${slotLineage}`, label: `Remove ${exerciseName(previous.slot.exerciseId)}`, before: exerciseName(previous.slot.exerciseId), after: null });
        continue;
      }
      if (previous.slot.exerciseId !== currentSlot.slot.exerciseId) {
        changes.push({ kind: "replace", path: `slots.${slotLineage}.exerciseId`, label: `Replace ${exerciseName(previous.slot.exerciseId)} with ${exerciseName(currentSlot.slot.exerciseId)}`, before: exerciseName(previous.slot.exerciseId), after: exerciseName(currentSlot.slot.exerciseId) });
      }
      if (previous.slotIndex !== currentSlot.slotIndex) {
        changes.push({ kind: "reorder", path: `slots.${slotLineage}`, label: `${exerciseName(currentSlot.slot.exerciseId)} order`, before: previous.slotIndex + 1, after: currentSlot.slotIndex + 1 });
      }
      if (canonicalJson(comparableTargets(previous.slot)) !== canonicalJson(comparableTargets(currentSlot.slot))) {
        changes.push({ kind: "targets", path: `slots.${slotLineage}.targets`, label: `${exerciseName(currentSlot.slot.exerciseId)} targets`, before: comparableTargets(previous.slot), after: comparableTargets(currentSlot.slot) });
      }
      if (canonicalJson(comparableDetails(previous.slot)) !== canonicalJson(comparableDetails(currentSlot.slot))) {
        changes.push({ kind: "details", path: `slots.${slotLineage}.details`, label: `${exerciseName(currentSlot.slot.exerciseId)} details`, before: comparableDetails(previous.slot), after: comparableDetails(currentSlot.slot) });
      }
      const previousSlotIntent = "intent" in previous.slot ? previous.slot.intent : null;
      const currentSlotIntent = "intent" in currentSlot.slot ? currentSlot.slot.intent : null;
      if (canonicalJson(previousSlotIntent) !== canonicalJson(currentSlotIntent)) {
        changes.push({
          kind: "intent",
          path: `slots.${slotLineage}.intent`,
          label: `${exerciseName(currentSlot.slot.exerciseId)} training intent`,
          before: previousSlotIntent ?? "Not recorded in this historical version",
          after: currentSlotIntent ?? "Not recorded in this historical version",
        });
      }
    }
    for (const [slotLineage, added] of nextSlots) {
      if (!baseSlotLocations.has(slotLineage) && !handledAddedSlots.has(slotLineage)) {
        changes.push({ kind: "add", path: `slots.${slotLineage}`, label: `Add ${exerciseName(added.slot.exerciseId)}`, before: null, after: exerciseName(added.slot.exerciseId) });
      }
    }
  }
  for (const [lineageId, { day }] of nextDays) {
    if (!baseDays.has(lineageId)) {
      changes.push({ kind: "add", path: `days.${lineageId}`, label: `Add ${day.name}`, before: null, after: day.name });
    }
  }
  const equipmentCodes = new Set([
    "equipment_unavailable",
    "active_avoid_constraint",
    "active_caution_constraint",
  ]);
  const painCodes = new Set(["recent_pain_association"]);
  const beforeEquipment = exposureSummary(
    context.basePublicationPreflight,
    equipmentCodes,
  );
  const afterEquipment = exposureSummary(
    context.nextPublicationPreflight,
    equipmentCodes,
  );
  if (canonicalJson(beforeEquipment) !== canonicalJson(afterEquipment)) {
    changes.push({
      kind: "intent",
      path: "preflight.equipmentExposure",
      label: "Publication-time equipment and constraint exposure",
      before: beforeEquipment,
      after: afterEquipment,
    });
  }
  const beforePain = exposureSummary(context.basePublicationPreflight, painCodes);
  const afterPain = exposureSummary(context.nextPublicationPreflight, painCodes);
  if (canonicalJson(beforePain) !== canonicalJson(afterPain)) {
    changes.push({
      kind: "intent",
      path: "preflight.painExposure",
      label: "Publication-time pain association",
      before: beforePain,
      after: afterPain,
    });
  }
  for (const day of next.days) {
    for (const slot of day.exercises) {
      if (slot.restSec < 30) cautions.push(`${day.name} has an exercise with less than 30 seconds of rest.`);
      if (slot.targetLoad != null && slot.targetLoad === 0) cautions.push(`${day.name} contains a zero target load.`);
    }
  }
  if (changes.length === 0) cautions.push("This draft is identical to the active version.");
  const documentHash = hashProgramDocument(next);
  const preflight = isIntentBearingProgramDocument(next)
    ? runProgramPreflight(
        projectIntentProgramDocumentV2(next),
        context.preflightContext,
      )
    : null;
  const beforeSummary = programSummary(base, exerciseInfo);
  const afterSummary = programSummary(next, exerciseInfo);
  const summary = {
    weeklySetsBefore: beforeSummary.weeklySets,
    weeklySetsAfter: afterSummary.weeklySets,
    durationBefore: beforeSummary.duration,
    durationAfter: afterSummary.duration,
    muscleSetsBefore: beforeSummary.muscleSets,
    muscleSetsAfter: afterSummary.muscleSets,
  };
  const blockingErrors =
    preflight?.findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => finding.reason) ?? [];
  const hash = sha256Hex(Buffer.from(canonicalJson({
    baseVersionId: base.baseVersionId,
    revision,
    documentHash,
    changes,
    recommendationRevision,
    recommendationConsequences,
    summary,
    preflight,
  }), "utf8"));
  const shared = {
    reviewedRevision: revision,
    changes,
    cautions: [...new Set([...cautions, ...(preflight?.findings.filter((finding) => finding.severity === "warning").map((finding) => finding.reason) ?? [])])],
    preflight,
    recommendationRevision,
    recommendationConsequences,
    summary,
  };
  return blockingErrors.length > 0
    ? {
        ...shared,
        status: "blocked",
        hash: null,
        blockingErrors,
      }
    : {
        ...shared,
        status: "publishable",
        hash,
        blockingErrors: [],
      };
}

export async function listProgramVersionHistory(db: Db, userId: string, programId: string) {
  const program = await db.query.programs.findFirst({
    where: and(eq(programs.id, programId), eq(programs.userId, userId)),
  });
  if (!program) return [];
  const versions = await db.query.programVersions.findMany({
    where: eq(programVersions.programId, program.id),
    orderBy: (version, { desc }) => [desc(version.versionNo)],
  });
  return versions.map((version) => ({
    id: version.id,
    versionNo: version.versionNo,
    name: version.name,
    activatedAt: version.activatedAt.toISOString(),
    source: version.publicationSource,
    summary: version.changeSummary,
    parentVersionId: version.parentVersionId,
    restoredFromVersionId: version.restoredFromVersionId,
    sourceImportEventId: version.sourceImportEventId,
    reviewHash: version.reviewHash,
    documentSchemaVersion: version.documentSchemaVersion,
    publicationPreflight: version.publicationPreflight,
    isCurrent: version.id === program.currentVersionId,
  }));
}
