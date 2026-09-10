import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { supersetGroups } from "@/db/schema";
import {
  projectProgramPresentation,
  type ProgramPresentation,
} from "@/lib/program-presentation";
import {
  getActiveProgramVersion,
  getTemplatesWithSlots,
  type TemplateWithSlots,
} from "@/services/program";

export async function getActiveProgramPresentation(
  db: Db,
  userId: string,
): Promise<ProgramPresentation | null> {
  const active = await getActiveProgramVersion(db, userId);
  if (!active) return null;
  const templates = await getTemplatesWithSlots(db, active.version.id);
  const groupIds = [
    ...new Set(
      templates.flatMap(({ slots }) =>
        slots.flatMap(({ slot }) =>
          slot.supersetGroupId ? [slot.supersetGroupId] : [],
        ),
      ),
    ),
  ];
  const groups = groupIds.length
    ? await db.query.supersetGroups.findMany({
        where: inArray(supersetGroups.id, groupIds),
      })
    : [];

  return projectProgramPresentation({
    program: { id: active.program.id, name: active.program.name },
    version: {
      id: active.version.id,
      versionNo: active.version.versionNo,
    },
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      restAfterRoundSec: group.restAfterRoundSec,
    })),
    days: templates.map(templatePresentationSource),
  });
}

/** Same saved-template projection for Program and Today; no extra database read. */
export function templatePresentationSource({
  template,
  slots,
}: TemplateWithSlots) {
  return {
    id: template.id,
    lineageId: template.lineageId,
    name: template.name,
    notes: template.notes,
    warmupNotes: template.warmupNotes,
    warmupItems: template.warmupItems,
    orderIdx: template.orderIdx,
    intent: template.intent,
    slots: slots.map(({ slot, exercise, prescription }) => ({
      id: slot.id,
      lineageId: slot.lineageId,
      exercise: {
        formDemo: exercise.formDemo,
        id: exercise.id,
        name: exercise.name,
        family: exercise.family,
        movementPattern: exercise.movementPattern,
        muscleMapping: {
          primary:
            exercise.coverageMapping?.primary ?? exercise.primaryMuscles ?? [],
          supporting:
            exercise.coverageMapping?.supporting ??
            exercise.secondaryMuscles ??
            [],
          ...(exercise.coverageMapping
            ? { coverageReview: exercise.coverageMapping.coverageReview }
            : {}),
          catalogReviewed: exercise.catalogReviewed === true,
        },
      },
      orderIdx: slot.orderIdx,
      supersetGroupId: slot.supersetGroupId,
      restSec: slot.restSec,
      notes: slot.notes,
      warmupNotes: slot.warmupNotes,
      warmupSets: slot.warmupSets,
      prescription: prescription
        ? {
            timedPrescription: prescription.timedPrescription,
            sets: prescription.sets,
            repRangeMin: prescription.repRangeMin,
            repRangeMax: prescription.repRangeMax,
            targetLoad: prescription.targetLoad,
            targetLoadUnit: prescription.targetLoadUnit,
            progressionRuleId: prescription.progressionRuleId,
          }
        : null,
    })),
  };
}
