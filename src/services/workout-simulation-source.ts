import "server-only";

import { and, count, eq, gt, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import type { Db } from "@/db";
import {
  constraints as constraintsTable,
  exerciseEquipmentRequirements,
  exerciseExecutionRequirements,
  equipmentItems,
  painLogs,
  plateInventory,
  supersetGroups,
  userProfiles,
  workoutSessions,
  workoutTemplateExercises,
} from "@/db/schema";
import type { EquipmentRequirement, InventoryItem } from "@/engine/equipment-filter";
import type { ExactExecutionRequirement } from "@/engine/exact-equipment-availability";
import { rankExerciseAlternatives } from "@/lib/exercise-alternatives";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { isExerciseEquipmentFitRecommendationSafe } from "@/lib/exercise-equipment-fit";
import { formatWarmupSetLine } from "@/lib/warmup";
import {
  buildSessionEquipmentPresentation,
  type EquipmentPresentationPlate,
} from "@/lib/session-equipment-presentation";
import {
  SIMULATION_LABEL_MAX_LENGTH,
  simulationSourceSnapshotSchema,
  type SimulationSourceSnapshot,
} from "@/lib/workout-simulation";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import {
  loadEquipmentLoadProfiles,
  type LoadedEquipmentLoadProfile,
} from "@/services/equipment-load-profiles";
import { getActiveProgramPresentation } from "@/services/program-presentation";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

export const SIMULATION_SOURCE_MAX_DAYS = 14;
export const SIMULATION_SOURCE_MAX_SLOTS_PER_DAY = 60;
export const SIMULATION_SOURCE_MAX_TOTAL_SLOTS = 840;
export const SIMULATION_SOURCE_MAX_LIBRARY_EXERCISES = 600;
export const SIMULATION_SOURCE_MAX_ALTERNATIVES_PER_SLOT = 8;
export const SIMULATION_SOURCE_MAX_EQUIPMENT_ITEMS = 200;
export const SIMULATION_SOURCE_MAX_PLATES = 200;
export const SIMULATION_SOURCE_MAX_EQUIPMENT_PROFILES = 300;
export const SIMULATION_SOURCE_MAX_CONSTRAINTS = 100;
export const SIMULATION_SOURCE_PAIN_WINDOW_DAYS = 14;

type ProgramPresentation = NonNullable<
  Awaited<ReturnType<typeof getActiveProgramPresentation>>
>;
type SourceConstraint = {
  id: string;
  bodyPart: string;
  affectedPatterns: string[];
  avoid: boolean;
  cautious: boolean;
  painStopThreshold: number;
  note: string | null;
};
type SourceEquipmentItem = {
  type: string;
  available: boolean;
  maxWeight: number | null;
};
type SlotSupplement = {
  groupMemberOrderIdx: number | null;
  setNotes: Array<string | null>;
};
type GroupSupplement = {
  orderIdx: number;
  plannedRounds: number | null;
  restBetweenMembersSec: number | null;
};

export type BuildSimulationSourceInput = {
  ownerId: string;
  capturedAtISO: string;
  program: ProgramPresentation;
  library: ExerciseDiscoveryItem[];
  equipmentItems: SourceEquipmentItem[];
  plates: EquipmentPresentationPlate[];
  profiles: LoadedEquipmentLoadProfile[];
  constraints: SourceConstraint[];
  painEvidenceByExerciseId: Record<string, number>;
  displayLoadUnit: "lb" | "kg";
  broadRequirementsByExerciseId: Record<string, EquipmentRequirement[]>;
  exactRequirementsByExerciseId: Record<string, ExactExecutionRequirement | null>;
  slotSupplementsById: Record<string, SlotSupplement>;
  groupSupplementsById: Record<string, GroupSupplement>;
};

function assertBound(label: string, count: number, maximum: number) {
  if (count > maximum) {
    throw new Error(`${label} exceeds the simulation source limit of ${maximum}.`);
  }
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function splitSimulationLabel(value: string): string[] {
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < value.length;
    offset += SIMULATION_LABEL_MAX_LENGTH
  ) {
    chunks.push(value.slice(offset, offset + SIMULATION_LABEL_MAX_LENGTH));
  }
  return chunks;
}

function inventoryFor(items: SourceEquipmentItem[]): InventoryItem[] {
  return [...items]
    .sort((left, right) => left.type.localeCompare(right.type))
    .map((item) => ({
      type: item.type,
      available: item.available,
      attrs: item.maxWeight == null ? {} : { maxWeight: item.maxWeight },
    }));
}

function simulationEquipmentFit(exercise: ExerciseDiscoveryItem) {
  const fit = exercise.equipmentFit;
  if (!fit || !exercise.equipmentFitStatus || !exercise.equipmentFitReason) {
    return {
      semanticsVersion: 1 as const,
      status: "unknown" as const,
      reason: "No retained stable-ID equipment-fit evidence is available for this exercise.",
      equipmentItemIds: [] as string[],
    };
  }
  return {
    semanticsVersion: 1 as const,
    status: fit.status,
    reason: fit.reason,
    equipmentItemIds: fit.status === "compatible"
      ? fit.compatibleEquipmentItemIds
      : fit.status === "incompatible"
        ? fit.incompatibleEquipmentItemIds
        : fit.candidateEquipmentItemIds,
  };
}

function equipmentOptions(input: {
  slotId: string;
  exercise: ExerciseDiscoveryItem;
  targetLoad: number | null;
  targetLoadUnit: "lb" | "kg" | null;
  requirements: EquipmentRequirement[];
  exactRequirement: ExactExecutionRequirement | null;
  profiles: LoadedEquipmentLoadProfile[];
  inventory: InventoryItem[];
  plates: EquipmentPresentationPlate[];
}) {
  const presentation = buildSessionEquipmentPresentation({
    exercise: {
      id: input.slotId,
      exerciseId: input.exercise.id,
      loadType: input.exercise.loadType,
      targetLoad: input.targetLoad,
      targetLoadUnit: input.targetLoadUnit,
      requirements: input.requirements,
      exactRequirement: input.exactRequirement,
      currentSelection: null,
    },
    profiles: input.profiles,
    inventory: input.inventory,
    plates: input.plates,
  });
  return (presentation.setup?.options ?? []).map((option) => ({
    key: option.key,
    label: option.attachmentLabel
      ? `${option.equipmentLabel} + ${option.attachmentLabel}`
      : option.equipmentLabel,
    guidance: option.guidance ?? null,
  }));
}

function painGuidance(input: {
  exercise: ExerciseDiscoveryItem;
  constraints: SourceConstraint[];
  recentPainEvidenceCount: number;
}) {
  const matching = input.constraints.filter((constraint) =>
    constraint.affectedPatterns.includes(input.exercise.movementPattern),
  );
  const lines = matching.flatMap((constraint) => {
    const instruction = constraint.avoid
      ? `Avoid ${input.exercise.movementPattern.replaceAll("_", " ")} movements involving ${constraint.bodyPart}.`
      : constraint.cautious
        ? `Use caution with ${constraint.bodyPart}.`
        : `A ${constraint.bodyPart} constraint is recorded for this movement.`;
    return [
      `${instruction} Stop if pain reaches ${constraint.painStopThreshold}/10 or higher.`,
      ...(constraint.note ? [constraint.note] : []),
    ];
  });
  for (const bodyPart of input.exercise.cautionBodyParts) {
    lines.push(`Use caution with ${bodyPart}.`);
  }
  if (input.recentPainEvidenceCount > 0) {
    lines.push(
      `${input.recentPainEvidenceCount} recent pain ${input.recentPainEvidenceCount === 1 ? "entry applies" : "entries apply"} to this exercise.`,
    );
  }
  return sortedUnique(lines);
}

function digestFor(snapshot: Omit<SimulationSourceSnapshot, "sourceDigest" | "capturedAtISO">) {
  return sha256Hex(Buffer.from(canonicalJson(snapshot), "utf8"));
}

/**
 * Build the bounded, serializable copy consumed by the device-local simulator.
 * The digest excludes capture time, so unchanged Program and source facts have
 * the same identity across repeated reads.
 */
export function buildSimulationSourceSnapshot(
  input: BuildSimulationSourceInput,
): SimulationSourceSnapshot {
  const capturedAt = new Date(input.capturedAtISO);
  if (!input.ownerId) throw new Error("Simulation source owner is required.");
  if (!Number.isFinite(capturedAt.getTime()) || capturedAt.toISOString() !== input.capturedAtISO) {
    throw new Error("Simulation source capture time must be an exact ISO timestamp.");
  }
  assertBound("Program day count", input.program.days.length, SIMULATION_SOURCE_MAX_DAYS);
  assertBound("Exercise library", input.library.length, SIMULATION_SOURCE_MAX_LIBRARY_EXERCISES);
  assertBound("Equipment inventory", input.equipmentItems.length, SIMULATION_SOURCE_MAX_EQUIPMENT_ITEMS);
  assertBound("Plate inventory", input.plates.length, SIMULATION_SOURCE_MAX_PLATES);
  assertBound("Equipment profiles", input.profiles.length, SIMULATION_SOURCE_MAX_EQUIPMENT_PROFILES);
  assertBound("Constraints", input.constraints.length, SIMULATION_SOURCE_MAX_CONSTRAINTS);
  const totalSlots = input.program.days.reduce((sum, day) => sum + day.slots.length, 0);
  assertBound("Program slot count", totalSlots, SIMULATION_SOURCE_MAX_TOTAL_SLOTS);

  const library = [...input.library].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const profiles = [...input.profiles].sort(
    (left, right) => left.itemLabel.localeCompare(right.itemLabel) ||
      left.equipmentItemId.localeCompare(right.equipmentItemId),
  );
  const plates = [...input.plates].sort(
    (left, right) => left.unit.localeCompare(right.unit) ||
      right.denomination - left.denomination || left.id.localeCompare(right.id),
  );
  const constraints = [...input.constraints]
    .map((constraint) => ({
      ...constraint,
      affectedPatterns: sortedUnique(constraint.affectedPatterns),
    }))
    .sort((left, right) => left.bodyPart.localeCompare(right.bodyPart) || left.id.localeCompare(right.id));
  const inventory = inventoryFor(input.equipmentItems);

  const days = [...input.program.days]
    .sort((left, right) => left.orderIdx - right.orderIdx || left.id.localeCompare(right.id))
    .map((day) => {
      assertBound(`Program day ${day.name} slot count`, day.slots.length, SIMULATION_SOURCE_MAX_SLOTS_PER_DAY);
      const exercises = [...day.slots]
        .sort((left, right) => left.orderIdx - right.orderIdx || left.id.localeCompare(right.id))
        .map((slot) => {
          const planned = libraryById.get(slot.exercise.id);
          if (!planned) throw new Error(`Program exercise ${slot.exercise.id} is not owner-visible.`);
          const supplement = input.slotSupplementsById[slot.id];
          if (!supplement) throw new Error(`Program slot ${slot.id} is incomplete.`);
          const targetLoad = slot.prescription?.targetLoad ?? null;
          const targetLoadUnit = slot.prescription?.targetLoadUnit ?? null;
          const requirements = input.broadRequirementsByExerciseId[planned.id] ?? [];
          const exactRequirement = input.exactRequirementsByExerciseId[planned.id] ?? null;
          const recentPainEvidenceCount = input.painEvidenceByExerciseId[planned.id] ?? 0;
          const alternatives = rankExerciseAlternatives(
            planned,
            library.filter((candidate) => candidate.id !== planned.id),
          )
            .filter((candidate) =>
              candidate.item.available &&
              candidate.item.metricType === planned.metricType &&
              Boolean(candidate.item.equipmentFit) &&
              isExerciseEquipmentFitRecommendationSafe(candidate.item.equipmentFit!),
            )
            .flatMap((candidate) => {
              const exactAlternativeRequirement =
                input.exactRequirementsByExerciseId[candidate.item.id] ?? null;
              const candidateEquipmentOptions = equipmentOptions({
                slotId: slot.id,
                exercise: candidate.item,
                targetLoad,
                targetLoadUnit,
                requirements: input.broadRequirementsByExerciseId[candidate.item.id] ?? [],
                exactRequirement: exactAlternativeRequirement,
                profiles,
                inventory,
                plates,
              });
              // A reviewed exact requirement is executable only through one of
              // the compatible primary/attachment combinations resolved above.
              // Broad-only bodyweight and fixed-load alternatives legitimately
              // have no selectable equipment option.
              if (exactAlternativeRequirement && candidateEquipmentOptions.length === 0) {
                return [];
              }
              return [{
                exerciseId: candidate.item.id,
                name: candidate.item.name,
                loadType: candidate.item.loadType,
                equipmentFit: simulationEquipmentFit(candidate.item),
                equipmentOptions: candidateEquipmentOptions,
                painGuidance: painGuidance({
                  exercise: candidate.item,
                  constraints,
                  recentPainEvidenceCount: input.painEvidenceByExerciseId[candidate.item.id] ?? 0,
                }),
                media: candidate.item.media ?? null,
              }];
            })
            .slice(0, SIMULATION_SOURCE_MAX_ALTERNATIVES_PER_SLOT);
          const setNotes = supplement.setNotes.filter((note): note is string => Boolean(note?.trim()));
          return {
            id: slot.id,
            exerciseId: planned.id,
            name: planned.name,
            orderIdx: slot.orderIdx,
            groupId: slot.supersetGroupId,
            groupMemberOrderIdx: supplement.groupMemberOrderIdx,
            sets: slot.prescription?.sets ?? setNotes.length,
            repsMin: slot.prescription?.repRangeMin ?? null,
            repsMax: slot.prescription?.repRangeMax ?? null,
            targetLoad,
            targetLoadUnit,
            restSec: slot.restSec,
            note: [slot.notes, ...setNotes].filter((note): note is string => Boolean(note?.trim())).join("\n") || null,
            warmups: slot.warmupSets.map((set, index) => ({
              id: `${slot.id}:warmup:${index}`,
              label: formatWarmupSetLine(set) || `Warm-up ${index + 1}`,
              orderIdx: index,
              note: set.notes ?? null,
            })),
            alternatives,
            equipmentOptions: equipmentOptions({
              slotId: slot.id,
              exercise: planned,
              targetLoad,
              targetLoadUnit,
              requirements,
              exactRequirement,
              profiles,
              inventory,
              plates,
            }),
            painGuidance: painGuidance({ exercise: planned, constraints, recentPainEvidenceCount }),
            media: planned.media ?? null,
            loadType: planned.loadType,
            equipmentFit: simulationEquipmentFit(planned),
          };
        });
      const groupIds = sortedUnique(exercises.flatMap((exercise) => exercise.groupId ? [exercise.groupId] : []));
      const groups = groupIds.map((groupId) => {
        const presentation = day.slots.find((slot) => slot.superset?.id === groupId)?.superset;
        const supplement = input.groupSupplementsById[groupId];
        if (!presentation || !supplement) throw new Error(`Program group ${groupId} is incomplete.`);
        const memberSets = exercises
          .filter((exercise) => exercise.groupId === groupId)
          .map((exercise) => exercise.sets);
        if (memberSets.length === 0) {
          throw new Error(`Program group ${groupId} has no simulation members.`);
        }
        const plannedRounds = supplement.plannedRounds ??
          Math.max(...memberSets);
        return {
          id: groupId,
          name: presentation.name,
          orderIdx: supplement.orderIdx,
          plannedRounds,
          restBetweenMembersSec: supplement.restBetweenMembersSec ?? 0,
          restBetweenRoundsSec: presentation.restAfterRoundSec,
        };
      }).sort((left, right) => left.orderIdx - right.orderIdx || left.id.localeCompare(right.id));
      return {
        id: day.id,
        name: day.name,
        orderIdx: day.orderIdx,
        warmups: day.warmupLines
          .flatMap(splitSimulationLabel)
          .map((label, index) => ({
            id: `${day.id}:warmup:${index}`,
            label,
            orderIdx: index,
            note: null,
          })),
        groups,
        exercises,
      };
    });

  const withoutDigest: Omit<SimulationSourceSnapshot, "sourceDigest" | "capturedAtISO"> = {
    schemaVersion: 1,
    ownerId: input.ownerId,
    program: {
      id: input.program.program.id,
      versionId: input.program.version.id,
      versionNo: input.program.version.versionNo,
      name: input.program.program.name,
    },
    unit: input.displayLoadUnit,
    days,
  };
  return simulationSourceSnapshotSchema.parse({
    ...withoutDigest,
    sourceDigest: digestFor(withoutDigest),
    capturedAtISO: input.capturedAtISO,
  });
}

/** Read the current owned published Program and all bounded rehearsal facts. No writes. */
export async function loadWorkoutSimulationSource(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<SimulationSourceSnapshot | null> {
  const program = await getActiveProgramPresentation(db, userId);
  if (!program) return null;
  const library = await getExerciseDiscoveryLibrary(db, userId);
  assertBound("Exercise library", library.length, SIMULATION_SOURCE_MAX_LIBRARY_EXERCISES);
  const slotIds = program.days.flatMap((day) => day.slots.map((slot) => slot.id));
  const groupIds = sortedUnique(program.days.flatMap((day) =>
    day.slots.flatMap((slot) => slot.supersetGroupId ? [slot.supersetGroupId] : []),
  ));
  const libraryIds = library.map((exercise) => exercise.id);
  const painWindowStart = new Date(now.getTime() - SIMULATION_SOURCE_PAIN_WINDOW_DAYS * 86_400_000);

  const [items, plates, profiles, constraints, profile, slotSupplements, groupSupplements, painRows] =
    await Promise.all([
      db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }),
      db.query.plateInventory.findMany({ where: eq(plateInventory.userId, userId) }),
      loadEquipmentLoadProfiles(db, userId),
      db.query.constraints.findMany({ where: eq(constraintsTable.userId, userId) }),
      db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, userId) }),
      slotIds.length > 0
        ? db.query.workoutTemplateExercises.findMany({ where: inArray(workoutTemplateExercises.id, slotIds) })
        : Promise.resolve([]),
      groupIds.length > 0
        ? db.query.supersetGroups.findMany({ where: inArray(supersetGroups.id, groupIds) })
        : Promise.resolve([]),
      libraryIds.length > 0
        ? db.select({
            exerciseId: painLogs.exerciseId,
            evidenceCount: count(painLogs.id),
          }).from(painLogs)
            .innerJoin(
              workoutSessions,
              eq(painLogs.sessionId, workoutSessions.id),
            )
            .where(and(
              eq(painLogs.userId, userId),
              eq(workoutSessions.userId, userId),
              eq(workoutSessions.status, "completed"),
              isNull(workoutSessions.archivedAt),
              isNull(painLogs.archivedAt),
              ne(painLogs.source, "set_exception"),
              // Zero is retained raw evidence, but it is not a pain report
              // and cannot stand in for a pain-free session.
              gte(painLogs.severity, 1),
              inArray(painLogs.exerciseId, libraryIds),
              gt(painLogs.createdAt, painWindowStart),
              lte(painLogs.createdAt, now),
            ))
            .groupBy(painLogs.exerciseId)
        : Promise.resolve([]),
    ]);
  if (!profile) throw new Error("The simulation owner profile is unavailable.");
  const [broadRequirements, exactRequirements] = libraryIds.length > 0
    ? await Promise.all([
        db.query.exerciseEquipmentRequirements.findMany({
          where: inArray(exerciseEquipmentRequirements.exerciseId, libraryIds),
        }),
        db.query.exerciseExecutionRequirements.findMany({
          where: inArray(exerciseExecutionRequirements.exerciseId, libraryIds),
        }),
      ])
    : [[], []];

  const broadRequirementsByExerciseId: Record<string, EquipmentRequirement[]> = {};
  for (const requirement of broadRequirements) {
    (broadRequirementsByExerciseId[requirement.exerciseId] ??= []).push({
      equipmentType: requirement.equipmentType,
      minWeight: requirement.minWeight,
    });
  }
  for (const requirements of Object.values(broadRequirementsByExerciseId)) {
    requirements.sort((left, right) =>
      left.equipmentType.localeCompare(right.equipmentType) ||
      (left.minWeight ?? 0) - (right.minWeight ?? 0),
    );
  }
  const exactRequirementsByExerciseId: Record<string, ExactExecutionRequirement | null> = {};
  for (const requirement of exactRequirements) {
    exactRequirementsByExerciseId[requirement.exerciseId] = {
      requiredProfileKind: requirement.requiredProfileKind,
      requiredEquipmentDefinitionId: requirement.requiredEquipmentDefinitionId,
      requiredAttachmentKind: requirement.requiredAttachmentKind,
      requiredAttachmentDefinitionId: requirement.requiredAttachmentDefinitionId,
      requiresKnownGeometry: requirement.requiresKnownGeometry,
    };
  }
  const painEvidenceByExerciseId: Record<string, number> = {};
  for (const row of painRows) {
    if (row.exerciseId) painEvidenceByExerciseId[row.exerciseId] = row.evidenceCount;
  }

  return buildSimulationSourceSnapshot({
    ownerId: userId,
    capturedAtISO: now.toISOString(),
    program,
    library,
    equipmentItems: items.map((item) => ({
      type: item.type,
      available: item.available,
      maxWeight: item.attrs.maxWeight ?? null,
    })),
    plates: plates.map((plate) => ({
      id: plate.id,
      denomination: plate.denomination,
      quantity: plate.quantity,
      unit: plate.unit,
    })),
    profiles,
    constraints: constraints.map((constraint) => ({
      id: constraint.id,
      bodyPart: constraint.bodyPart,
      affectedPatterns: [...constraint.affectedPatterns],
      avoid: constraint.avoid,
      cautious: constraint.cautious,
      painStopThreshold: constraint.painStopThreshold,
      note: constraint.note,
    })),
    painEvidenceByExerciseId,
    displayLoadUnit: profile.unit,
    broadRequirementsByExerciseId,
    exactRequirementsByExerciseId,
    slotSupplementsById: Object.fromEntries(slotSupplements.map((slot) => [slot.id, {
      groupMemberOrderIdx: slot.groupMemberOrderIdx,
      setNotes: [...slot.setNotes],
    }])),
    groupSupplementsById: Object.fromEntries(groupSupplements.map((group) => [group.id, {
      orderIdx: group.orderIdx,
      plannedRounds: group.plannedRounds,
      restBetweenMembersSec: group.restBetweenMembersSec,
    }])),
  });
}
