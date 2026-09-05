import {
  buildEquipmentAvailability,
  equipmentItemProvidesType,
  requirementSatisfied,
  type EquipmentRequirement,
  type InventoryItem,
} from "@/engine/equipment-filter";
import {
  resolveExactEquipmentAvailability,
  type ExactExecutionCandidate,
  type ExactExecutionRequirement,
  type ExactAvailabilityResolution,
} from "@/engine/exact-equipment-availability";
import { resolveImplementLoadSelection } from "@/engine/implement-load-selection";
import {
  solveMachineLoad,
  type MachineLoadConfig,
} from "@/engine/machine-load-math";
import {
  selectCableLoad,
  selectCombinedIndependentCableLoad,
  type CableLoadConfig,
} from "@/engine/cable-load-selection";
import type { PlateMathConfig } from "@/engine/plate-math";
import { formatPlateLoadGuidance } from "@/lib/exercise-card";
import type { SessionEquipmentGeometrySnapshot } from "@/lib/session-equipment-snapshot-contract";
import { resolveProspectiveMachinePlates } from "@/lib/machine-plate-compatibility";
import { convertWeight, type LoadUnit } from "@/lib/units";
import type { LoadedEquipmentLoadProfile } from "@/services/equipment-load-profiles";
import type { SessionEquipmentSetup } from "@/components/session/types";

export type EquipmentPresentationPlate = {
  id: string;
  denomination: number;
  quantity: number;
  unit: LoadUnit;
};

export type CurrentEquipmentSelection = {
  id: string;
  equipmentItemId: string | null;
  attachmentItemId: string | null;
  equipmentLabel: string;
  attachmentLabel: string | null;
  geometrySnapshot: SessionEquipmentGeometrySnapshot;
};

type ExerciseInput = {
  id: string;
  exerciseId: string;
  loadType: string;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  requirements: EquipmentRequirement[];
  exactRequirement: ExactExecutionRequirement | null;
  currentSelection: CurrentEquipmentSelection | null;
};

function targetInUnit(exercise: ExerciseInput, unit: LoadUnit | null) {
  if (exercise.targetLoad == null || exercise.targetLoadUnit == null || unit == null) {
    return null;
  }
  return convertWeight(exercise.targetLoad, exercise.targetLoadUnit, unit);
}

function platesText(plates: number[]) {
  return plates.length > 0 ? plates.join(" + ") : "no added plates";
}

function guidanceForGeometry(
  exercise: ExerciseInput,
  geometry: SessionEquipmentGeometrySnapshot,
  loadEntryMeaning: "per_stack" | "combined_stacks" = "per_stack",
): string | null {
  if (geometry.kind === "plate_loaded_implement") {
    const target = targetInUnit(exercise, geometry.unit);
    const config: PlateMathConfig = {
      barWeight: geometry.emptyWeight,
      collarWeight: geometry.collarWeight,
      plates: geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        countPerSide: Math.floor(plate.quantity / 2),
      })),
    };
    return target == null
      ? `Empty implement and collars: ${geometry.emptyWeight + geometry.collarWeight} ${geometry.unit}.`
      : formatPlateLoadGuidance(target, config, geometry.unit);
  }

  if (geometry.kind === "plate_loaded_machine") {
    const target = targetInUnit(exercise, geometry.startingResistanceUnit);
    if (target == null) {
      return geometry.geometryCertainty === "known"
        ? "Exact machine geometry is recorded; enter a target to calculate the plates."
        : "Machine geometry is not fully known, so exact plate guidance is unavailable.";
    }
    const result = solveMachineLoad(target, {
      geometryStatus: geometry.geometryCertainty,
      startingResistance: geometry.startingResistance,
      unit: geometry.startingResistanceUnit,
      loadingPointCount: geometry.loadingPointCount,
      balancingRule: geometry.balancingRule,
      targetEntryMeaning: geometry.targetEntryMeaning,
      compatiblePlates: geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        quantity: plate.quantity,
      })),
    });
    if (result.status === "unavailable") {
      return "Machine geometry is not fully known, so exact plate guidance is unavailable.";
    }
    const describe = (label: string, solution: NonNullable<typeof result.exact>) =>
      `${label} ${solution.enteredLoad} ${result.unit}: each loading point ${platesText(solution.platesPerPoint)}, ${geometry.targetEntryMeaning === "added_plates" ? `${solution.enteredLoad} ${result.unit} of added plates in total; unloaded resistance is not included` : `total resistance ${solution.canonicalTotalLoad} ${result.unit}`}`;
    if (result.exact) return `${describe("Exact setup", result.exact)}.`;
    const neighbours = [
      result.nearestBelow ? describe("nearest lower", result.nearestBelow) : null,
      result.nearestAbove ? describe("nearest upper", result.nearestAbove) : null,
    ].filter((value): value is string => value != null);
    return `Not loadable exactly · ${neighbours.join(" · ")}.`;
  }

  if (geometry.geometryCertainty !== "known" || geometry.displayedUnit == null) {
    return "Cable geometry is unknown. Record the displayed stack setting only; effective load is unknown.";
  }
  const target = targetInUnit(exercise, geometry.displayedUnit);
  if (target == null) {
    return geometry.ratioStatus === "unknown"
      ? "Use a recorded stack position. Pulley ratio is unknown, so effective load remains unknown."
      : "Use a recorded stack position; enter a target to calculate the exact pin setting.";
  }
  const schedules = Array.from(
    new Set(geometry.stackSteps.map((step) => step.stackIndex)),
  ).map((stackOrdinal) => ({
    stackOrdinal,
    steps: geometry.stackSteps
      .filter((step) => step.stackIndex === stackOrdinal)
      .map((step) => ({
        stepIndex: step.stepIndex,
        displayedLoad: step.displayedLoad,
        positionLabel: step.positionLabel,
      })),
  }));
  const config: CableLoadConfig = {
    geometryStatus: geometry.geometryCertainty,
    stackCount: geometry.stackCount,
    topology: geometry.topology,
    unit: geometry.displayedUnit,
    schedules,
    ratio: geometry.ratioStatus === "known" &&
      geometry.ratioNumerator != null && geometry.ratioDenominator != null
      ? {
          status: "known",
          numerator: geometry.ratioNumerator,
          denominator: geometry.ratioDenominator,
        }
      : { status: "unknown" },
  };
  if (
    geometry.topology === "independent_per_stack" &&
    loadEntryMeaning === "combined_stacks"
  ) {
    const combined = selectCombinedIndependentCableLoad(target, config);
    if (combined.status === "unavailable") {
      return "Cable stack positions are not fully recorded, so exact combined pin guidance is unavailable.";
    }
    const describe = (
      label: string,
      setup: NonNullable<typeof combined.exact>,
    ) => {
      const pins = setup.selections.map(({ stackOrdinal, step }) =>
        `stack ${stackOrdinal} ${step.displayedLoad} ${combined.unit}${step.positionLabel ? ` (${step.positionLabel})` : ""}`,
      ).join(" + ");
      return `${label} ${setup.displayedTotal} ${combined.unit}: ${pins}`;
    };
    const setupText = combined.exact
      ? describe("Combined exact", combined.exact)
      : [
          combined.nearestBelow
            ? describe("combined nearest lower", combined.nearestBelow)
            : null,
          combined.nearestAbove
            ? describe("combined nearest upper", combined.nearestAbove)
            : null,
        ].filter((value): value is string => value != null).join(" · ");
    if (geometry.ratioStatus === "unknown") {
      return `${setupText}. Pulley ratio is unknown, so effective load remains unknown.`;
    }
    const selected = combined.exact ?? null;
    return selected?.nominalHandleResistanceTotal != null
      ? `${setupText} · nominal combined handle resistance ${selected.nominalHandleResistanceTotal} ${combined.unit}; this is not measured force.`
      : `${setupText}.`;
  }

  const targets = geometry.topology === "independent_per_stack"
    ? Array.from({ length: geometry.stackCount ?? 0 }, () => target)
    : target;
  const result = selectCableLoad(targets, config);
  if (result.status === "unavailable") {
    return "Cable stack positions are not fully recorded, so exact pin guidance is unavailable.";
  }
  const selections = result.selections.map((selection) => {
    const stack = selection.stackOrdinal === 0 ? "stack" : `stack ${selection.stackOrdinal}`;
    const stepText = (label: string, step: NonNullable<typeof selection.exact>) => {
      const position = step.positionLabel ? ` (${step.positionLabel})` : "";
      return `${label} ${step.displayedLoad} ${result.unit}${position}`;
    };
    if (selection.exact) return `${stack}: ${stepText("exact", selection.exact)}`;
    const neighbours = [
      selection.nearestBelow ? stepText("nearest lower", selection.nearestBelow) : null,
      selection.nearestAbove ? stepText("nearest upper", selection.nearestAbove) : null,
    ].filter((value): value is string => value != null);
    return `${stack}: ${neighbours.length > 0 ? neighbours.join(" / ") : "no recorded position"}`;
  }).join(" · ");
  if (geometry.ratioStatus === "unknown") {
    return `${selections}. Pulley ratio is unknown, so effective load remains unknown.`;
  }
  const handle = result.nominalHandleResistance?.map((load, index) =>
    `${result.selections[index].stackOrdinal === 0 ? "handle" : `handle ${result.selections[index].stackOrdinal}`}: ${load} ${result.unit}`,
  ).join(" · ");
  return handle ? `${selections} · nominal ${handle}.` : `${selections}.`;
}

function geometryForProfile(
  profile: LoadedEquipmentLoadProfile["profile"],
  plates: EquipmentPresentationPlate[],
): SessionEquipmentGeometrySnapshot | null {
  if (profile.kind === "attachment") return null;
  if (profile.kind === "plate_loaded_implement") {
    return {
      version: 1,
      kind: profile.kind,
      loadingKind: profile.loadingKind,
      emptyWeight: profile.emptyWeight,
      collarWeight: profile.collarWeight,
      unit: profile.unit,
      sharedPlatePoolCompatible: profile.sharedPlatePoolCompatible,
      compatiblePlates: profile.sharedPlatePoolCompatible
        ? plates.filter((plate) => plate.unit === profile.unit).map((plate) => ({
            denomination: plate.denomination,
            quantity: plate.quantity,
            unit: plate.unit,
          }))
        : [],
    };
  }
  if (profile.kind === "plate_loaded_machine") {
    return {
      version: profile.targetEntryMeaning === "added_plates" ? 2 : 1,
      kind: profile.kind,
      geometryCertainty: profile.geometryCertainty,
      startingResistance: profile.startingResistance,
      startingResistanceUnit: profile.startingResistanceUnit,
      loadingPointCount: profile.loadingPointCount,
      balancingRule: profile.balancingRule,
      targetEntryMeaning: profile.targetEntryMeaning,
      compatiblePlates: resolveProspectiveMachinePlates(profile, plates).map(
        (plate) => ({
          denomination: plate.denomination,
          quantity: plate.quantity,
          unit: plate.unit,
        }),
      ),
    };
  }
  return {
    version: 1,
    kind: profile.kind,
    geometryCertainty: profile.geometryCertainty,
    stackCount: profile.stackCount,
    topology: profile.topology,
    displayedUnit: profile.displayedUnit,
    ratioStatus: profile.ratioStatus,
    ratioNumerator: profile.ratioNumerator,
    ratioDenominator: profile.ratioDenominator,
    stackSteps: profile.stackSteps.map((step) => ({
      stackIndex: step.stackIndex,
      stepIndex: step.stepIndex,
      displayedLoad: step.displayedLoad,
      positionLabel: step.positionLabel,
    })),
  };
}

function loadMeaningForGeometry(geometry: SessionEquipmentGeometrySnapshot) {
  if (geometry.kind === "plate_loaded_implement") {
    return { meaning: "total_system" as const, choices: [] as Array<"per_stack" | "combined_stacks"> };
  }
  if (geometry.kind === "plate_loaded_machine") {
    return { meaning: geometry.targetEntryMeaning, choices: [] as Array<"per_stack" | "combined_stacks"> };
  }
  if (geometry.topology === "shared_selection") {
    return { meaning: "displayed_stack" as const, choices: [] as Array<"per_stack" | "combined_stacks"> };
  }
  if (geometry.topology === "independent_per_stack") {
    return { meaning: "per_stack" as const, choices: ["per_stack", "combined_stacks"] as Array<"per_stack" | "combined_stacks"> };
  }
  return { meaning: null, choices: [] as Array<"per_stack" | "combined_stacks"> };
}

function machineConfigForGeometry(
  geometry: SessionEquipmentGeometrySnapshot | null | undefined,
): MachineLoadConfig | null {
  if (geometry?.kind !== "plate_loaded_machine") return null;
  return {
    geometryStatus: geometry.geometryCertainty,
    startingResistance: geometry.startingResistance,
    unit: geometry.startingResistanceUnit,
    loadingPointCount: geometry.loadingPointCount,
    balancingRule: geometry.balancingRule,
    targetEntryMeaning: geometry.targetEntryMeaning,
    compatiblePlates: geometry.compatiblePlates.map((plate) => ({
      denomination: plate.denomination,
      quantity: plate.quantity,
    })),
  };
}

function asExactCandidate(
  profile: LoadedEquipmentLoadProfile,
  profiles: LoadedEquipmentLoadProfile[],
): ExactExecutionCandidate | null {
  if (profile.profile.kind === "attachment") return null;
  return {
    equipmentItemId: profile.equipmentItemId,
    available: profile.available,
    profileKind: profile.profile.kind,
    equipmentDefinitionId: profile.equipmentDefinitionId,
    geometryCertainty: profile.profile.kind === "plate_loaded_implement"
      ? "known"
      : profile.profile.geometryCertainty,
    compatibleAttachments: profile.profile.kind === "cable_machine"
      ? profile.profile.compatibleAttachmentItemIds.flatMap((id) => {
          const attachment = profiles.find((entry) =>
            entry.equipmentItemId === id && entry.profile.kind === "attachment"
          );
          return attachment && attachment.profile.kind === "attachment" ? [{
            equipmentItemId: id,
            available: attachment.available,
            attachmentKind: attachment.profile.attachmentKind,
            equipmentDefinitionId: attachment.equipmentDefinitionId,
          }] : [];
        })
      : [],
  };
}

function missingGeometryFields(profile: LoadedEquipmentLoadProfile): string[] {
  if (profile.profile.kind === "plate_loaded_machine") {
    const missing = [
      profile.profile.startingResistance == null && profile.profile.targetEntryMeaning !== "added_plates" ? "starting resistance" : null,
      profile.profile.startingResistanceUnit == null ? "resistance unit" : null,
      profile.profile.loadingPointCount == null ? "loading points" : null,
      profile.profile.balancingRule == null ? "balancing rule" : null,
      profile.profile.targetEntryMeaning == null ? "load-entry meaning" : null,
    ].filter((value): value is string => value != null);
    return missing.length > 0 ? missing : ["known machine geometry confirmation"];
  }
  if (profile.profile.kind === "cable_machine") {
    const missing = [
      profile.profile.stackCount == null ? "stack count" : null,
      profile.profile.topology == null ? "stack topology" : null,
      profile.profile.displayedUnit == null ? "displayed unit" : null,
      profile.profile.stackSteps.length === 0 ? "stack positions" : null,
    ].filter((value): value is string => value != null);
    return missing.length > 0 ? missing : ["known cable geometry confirmation"];
  }
  return ["required equipment configuration"];
}

/**
 * Canonical current-inventory verdict for a catalog exercise. Exercise pickers
 * and the active-workout setup resolver share this projection so a broad
 * category such as `machine` cannot hide a stricter reviewed profile or
 * geometry requirement.
 */
export function resolveExerciseEquipmentAvailability(input: {
  requirements: EquipmentRequirement[];
  exactRequirement: ExactExecutionRequirement | null;
  profiles: LoadedEquipmentLoadProfile[];
  inventory: InventoryItem[];
  plates: EquipmentPresentationPlate[];
}): ExactAvailabilityResolution {
  const exactCandidates = input.profiles.flatMap((profile) => {
    const candidate = asExactCandidate(profile, input.profiles);
    return candidate ? [candidate] : [];
  });
  return resolveExactEquipmentAvailability({
    broadRequirements: input.requirements,
    broadInventory: buildEquipmentAvailability(
      input.inventory,
      input.plates.map((plate) => ({ denomination: plate.denomination })),
    ),
    exactRequirement: input.exactRequirement,
    exactCandidates,
  });
}

function attachmentMatches(
  exact: ExactExecutionRequirement | null,
  attachment: LoadedEquipmentLoadProfile,
) {
  if (attachment.profile.kind !== "attachment" || !attachment.available) return false;
  return exact == null || (
    (exact.requiredAttachmentKind == null || attachment.profile.attachmentKind === exact.requiredAttachmentKind) &&
    (exact.requiredAttachmentDefinitionId == null || attachment.equipmentDefinitionId === exact.requiredAttachmentDefinitionId)
  );
}

export function buildSessionEquipmentPresentation(input: {
  exercise: ExerciseInput;
  profiles: LoadedEquipmentLoadProfile[];
  inventory: InventoryItem[];
  plates: EquipmentPresentationPlate[];
  /** Optional retained-evidence fence for every primary equipment candidate. */
  primaryEquipmentAllowed?: (equipmentItemId: string) => boolean;
}): { setup: SessionEquipmentSetup | null; plateConfig: PlateMathConfig | null } {
  const { exercise, profiles, plates } = input;
  const candidateProfiles = profiles.filter((entry) =>
    entry.profile.kind === "attachment" ||
    (input.primaryEquipmentAllowed?.(entry.equipmentItemId) ?? true)
  );
  const primaries = candidateProfiles.filter(
    (entry) => entry.profile.kind !== "attachment",
  );
  const exactResolution = resolveExerciseEquipmentAvailability({
    requirements: exercise.requirements,
    exactRequirement: exercise.exactRequirement,
    profiles: candidateProfiles,
    inventory: input.inventory,
    plates,
  });

  let eligible: LoadedEquipmentLoadProfile[];
  if (exercise.exactRequirement) {
    const ids = new Set(exactResolution.candidateEquipmentItemIds);
    eligible = primaries.filter((profile) => ids.has(profile.equipmentItemId));
  } else if (exercise.loadType === "external" && exercise.requirements.some(
    (requirement) => ["cable", "machine", "smith_machine"].includes(requirement.equipmentType),
  ) && exactResolution.available) {
    eligible = primaries.filter((profile) => {
      if (!profile.available || !["plate_loaded_machine", "cable_machine"].includes(profile.profile.kind)) return false;
      const item = { type: profile.itemType, attrs: profile.itemAttrs ?? {}, available: profile.available };
      const primaryRequirements = exercise.requirements.filter((requirement) =>
        equipmentItemProvidesType(item, requirement.equipmentType));
      return primaryRequirements.length > 0 && primaryRequirements.every((requirement) =>
        requirementSatisfied(requirement, [item]));
    });
    // Broad ownership still permits manual logging when no exact profile exists.
    if (eligible.length === 0) return { setup: null, plateConfig: null };
  } else if (["barbell", "ez_bar", "trap_bar", "specialty_bar"].includes(exercise.loadType)) {
    const resolved = resolveImplementLoadSelection({
      loadType: exercise.loadType,
      candidates: primaries.flatMap((entry) => entry.profile.kind === "plate_loaded_implement" ? [{
        equipmentItemId: entry.equipmentItemId,
        configurationId: entry.profile.id ?? entry.equipmentItemId,
        label: entry.itemLabel,
        loadingKind: entry.profile.loadingKind,
        emptyWeight: entry.profile.emptyWeight,
        collarWeight: entry.profile.collarWeight,
        unit: entry.profile.unit,
        sharedPlatePoolCompatible: entry.profile.sharedPlatePoolCompatible,
        available: entry.available,
      }] : []),
      selectedEquipmentItemId: exercise.currentSelection?.equipmentItemId ?? null,
      sharedPlates: plates.map((plate) => ({ denomination: plate.denomination, quantity: plate.quantity })),
    });
    eligible = resolved.candidates.map((candidate) =>
      primaries.find((entry) => entry.equipmentItemId === candidate.equipmentItemId)!,
    );
  } else {
    // Reps-only and bodyweight movements can still depend on physical
    // equipment (for example, suspension straps). Preserve a canonical
    // unavailable/incompatible decision even when the exercise has no load
    // setup to select; otherwise the UI and server-side skip validation would
    // incorrectly treat the equipment fact as unknown.
    if (exactResolution.available) {
      return { setup: null, plateConfig: null };
    }
    eligible = [];
  }

  const options = eligible.flatMap((primary) => {
    const geometry = geometryForProfile(primary.profile, plates);
    if (!geometry) return [];
    if (primary.profile.kind !== "cable_machine") {
      const load = loadMeaningForGeometry(geometry);
      return [{
        key: `${primary.equipmentItemId}:none`,
        equipmentItemId: primary.equipmentItemId,
        equipmentLabel: primary.itemLabel,
        attachmentItemId: null,
        attachmentLabel: null,
        guidance: guidanceForGeometry(exercise, geometry),
        loadEntryMeaning: load.meaning,
        loadEntryMeaningChoices: load.choices,
      }];
    }
    const attachments = primary.profile.compatibleAttachmentItemIds
      .map((id) => profiles.find((entry) => entry.equipmentItemId === id))
      .filter((entry): entry is LoadedEquipmentLoadProfile =>
        entry != null && attachmentMatches(exercise.exactRequirement, entry),
      );
    const attachmentRequired = exercise.exactRequirement?.requiredAttachmentKind != null ||
      exercise.exactRequirement?.requiredAttachmentDefinitionId != null;
    const choices: Array<LoadedEquipmentLoadProfile | null> = attachmentRequired
      ? attachments
      : [null, ...attachments];
    const load = loadMeaningForGeometry(geometry);
    return choices.map((attachment) => ({
      key: `${primary.equipmentItemId}:${attachment?.equipmentItemId ?? "none"}`,
      equipmentItemId: primary.equipmentItemId,
      equipmentLabel: primary.itemLabel,
      attachmentItemId: attachment?.equipmentItemId ?? null,
      attachmentLabel: attachment?.itemLabel ?? null,
      guidance: guidanceForGeometry(exercise, geometry),
      loadEntryMeaning: load.meaning,
      loadEntryMeaningChoices: load.choices,
    }));
  });

  const current = exercise.currentSelection;
  const currentGuidance = current
    ? guidanceForGeometry(exercise, current.geometrySnapshot)
    : null;
  const currentGuidanceByLoadEntryMeaning =
    current?.geometrySnapshot.kind === "cable_machine" &&
    current.geometrySnapshot.topology === "independent_per_stack"
      ? {
          per_stack:
            guidanceForGeometry(exercise, current.geometrySnapshot, "per_stack") ??
            "",
          combined_stacks:
            guidanceForGeometry(
              exercise,
              current.geometrySnapshot,
              "combined_stacks",
            ) ?? "",
        }
      : {};
  const currentSelectionAvailable = current != null && options.some((option) =>
    option.equipmentItemId === current.equipmentItemId &&
    option.attachmentItemId === current.attachmentItemId
  );
  const incompleteIds = new Set(
    exactResolution.configurationIncompleteEquipmentItemIds,
  );
  const configurationIssues = primaries
    .filter((profile) => incompleteIds.has(profile.equipmentItemId))
    .map((profile) => ({
      equipmentItemId: profile.equipmentItemId,
      equipmentLabel: profile.itemLabel,
      missingFields: missingGeometryFields(profile),
    }));
  let plateConfig: PlateMathConfig | null = null;
  let loadEntryMeaning: SessionEquipmentSetup["loadEntryMeaning"] = null;
  if (current?.geometrySnapshot.kind === "plate_loaded_implement") {
    loadEntryMeaning = "total_system";
    plateConfig = {
      barWeight: current.geometrySnapshot.emptyWeight,
      collarWeight: current.geometrySnapshot.collarWeight,
      plates: current.geometrySnapshot.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        countPerSide: Math.floor(plate.quantity / 2),
      })),
    };
  } else if (current?.geometrySnapshot.kind === "plate_loaded_machine") {
    loadEntryMeaning = current.geometrySnapshot.targetEntryMeaning;
  } else if (current?.geometrySnapshot.kind === "cable_machine") {
    loadEntryMeaning = current.geometrySnapshot.topology === "shared_selection"
      ? "displayed_stack"
      : current.geometrySnapshot.topology === "independent_per_stack"
        ? "per_stack"
        : null;
  }

  return {
    setup: {
      sourceExerciseId: exercise.exerciseId,
      sourceTargetLoad: exercise.targetLoad,
      sourceTargetLoadUnit: exercise.targetLoadUnit,
      exact: exercise.exactRequirement != null,
      decisionState: options.length > 0
        ? "ready"
        : exactResolution.status === "broad_unavailable"
          ? "unavailable"
          : exactResolution.status === "configuration_incomplete"
            ? "configuration_incomplete"
          : "incompatible",
      status: options.length > 0 && exactResolution.status !== "broad_unavailable"
        ? "available"
        : "unavailable",
      configurationIssues,
      selectionRequired: current == null && options.length > 1,
      currentSnapshotId: current?.id ?? null,
      currentEquipmentLabel: current?.equipmentLabel ?? null,
      currentAttachmentLabel: current?.attachmentLabel ?? null,
      currentGuidance,
      currentGuidanceByLoadEntryMeaning,
      currentSelectionAvailable,
      loadEntryMeaning,
      loadEntryMeaningChoices:
        current?.geometrySnapshot.kind === "cable_machine" &&
        current.geometrySnapshot.topology === "independent_per_stack"
          ? ["per_stack", "combined_stacks"]
          : [],
      machineLoadConfig: machineConfigForGeometry(current?.geometrySnapshot),
      options,
    },
    plateConfig,
  };
}
