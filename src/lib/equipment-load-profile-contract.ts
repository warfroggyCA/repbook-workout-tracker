import { z } from "zod";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";

const storedLoad = z
  .number()
  .finite()
  .min(0)
  .max(MAX_STORED_LOAD)
  .transform(normalizeStoredLoad);
const positiveStoredLoad = storedLoad.pipe(z.number().positive());
const profileId = z.uuid().nullable();
const unit = z.enum(["lb", "kg"]);

export const plateLoadedImplementProfileSchema = z.object({
  kind: z.literal("plate_loaded_implement"),
  id: profileId,
  loadingKind: z.enum(["olympic", "ez", "trap_hex", "specialty"]),
  emptyWeight: positiveStoredLoad,
  collarWeight: storedLoad,
  unit,
  sharedPlatePoolCompatible: z.boolean(),
});

export const plateLoadedMachineProfileSchema = z
  .object({
    kind: z.literal("plate_loaded_machine"),
    id: profileId,
    geometryCertainty: z.enum(["known", "partial", "unknown"]),
    startingResistance: storedLoad.nullable(),
    startingResistanceUnit: unit.nullable(),
    loadingPointCount: z.number().int().min(1).max(16).nullable(),
    balancingRule: z.enum(["single_point", "identical_each_point"]).nullable(),
    targetEntryMeaning: z
      .enum(["total_system", "per_loading_point", "added_plates"])
      .nullable(),
    compatiblePlateIds: z.array(z.uuid()).max(100),
  })
  .superRefine((profile, context) => {
    const required = [
      ...(profile.targetEntryMeaning === "added_plates" ? [] : [profile.startingResistance]),
      profile.startingResistanceUnit,
      profile.loadingPointCount,
      profile.balancingRule,
      profile.targetEntryMeaning,
    ];
    if (profile.geometryCertainty === "known" && required.some((value) => value == null)) {
      const fields = [
        ["startingResistance", "Enter the machine's starting resistance; enter 0 only when it is known to be zero."],
        ["startingResistanceUnit", "Record the starting-resistance unit."],
        ["loadingPointCount", "Enter the number of loading points."],
        ["balancingRule", "Choose how the loading points are balanced."],
        ["targetEntryMeaning", "Choose what the entered workout load means."],
      ] as const;
      for (const [field, message] of fields) {
        if (field === "startingResistance" && profile.targetEntryMeaning === "added_plates") continue;
        if (profile[field] == null) context.addIssue({ code: "custom", path: [field], message });
      }
    }
    if (
      profile.geometryCertainty === "unknown" &&
      required.some((value) => value != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["geometryCertainty"],
        message: "Unknown machine geometry cannot retain calculation values.",
      });
    }
    if (
      profile.balancingRule === "single_point" &&
      profile.loadingPointCount != null &&
      profile.loadingPointCount !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["loadingPointCount"],
        message: "Single-point geometry must have exactly one loading point.",
      });
    }
    if (new Set(profile.compatiblePlateIds).size !== profile.compatiblePlateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["compatiblePlateIds"],
        message: "A compatible plate may be selected only once.",
      });
    }
  });

export const cableStackStepSchema = z.object({
  id: profileId,
  stackIndex: z.number().int().min(0).max(16),
  stepIndex: z.number().int().min(0).max(500),
  displayedLoad: storedLoad,
  positionLabel: z.string().trim().min(1).max(80).nullable(),
});

export const cableMachineProfileSchema = z
  .object({
    kind: z.literal("cable_machine"),
    id: profileId,
    geometryCertainty: z.enum(["known", "partial", "unknown"]),
    stackCount: z.number().int().min(1).max(16).nullable(),
    topology: z.enum(["shared_selection", "independent_per_stack"]).nullable(),
    displayedUnit: unit.nullable(),
    ratioStatus: z.enum(["known", "unknown"]),
    ratioNumerator: z.number().int().min(1).max(10_000).nullable(),
    ratioDenominator: z.number().int().min(1).max(10_000).nullable(),
    stackSteps: z.array(cableStackStepSchema).max(1_000),
    compatibleAttachmentItemIds: z.array(z.uuid()).max(100),
  })
  .superRefine((profile, context) => {
    if (
      profile.ratioStatus === "known" &&
      (profile.ratioNumerator == null || profile.ratioDenominator == null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ratioStatus"],
        message: "A known cable ratio needs both positive ratio values.",
      });
    }
    if (
      profile.ratioStatus === "unknown" &&
      (profile.ratioNumerator != null || profile.ratioDenominator != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ratioStatus"],
        message: "Unknown cable geometry cannot retain a ratio value.",
      });
    }
    if (
      profile.geometryCertainty === "known" &&
      (profile.stackCount == null || profile.topology == null || profile.displayedUnit == null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["geometryCertainty"],
        message: "Known cable geometry needs its stack count, topology, and unit.",
      });
    }
    if (
      profile.geometryCertainty === "known" &&
      profile.stackSteps.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["stackSteps"],
        message: "Known cable geometry needs at least one recorded stack position.",
      });
    }
    if (
      profile.geometryCertainty === "unknown" &&
      (profile.stackCount != null ||
        profile.topology != null ||
        profile.displayedUnit != null ||
        profile.stackSteps.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["geometryCertainty"],
        message: "Unknown cable geometry cannot retain stack calculation values.",
      });
    }
    if (
      profile.topology === "shared_selection" &&
      profile.stackSteps.some((step) => step.stackIndex !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stackSteps"],
        message: "A shared stack schedule uses stack ordinal zero.",
      });
    }
    if (
      profile.topology === "independent_per_stack" &&
      profile.stackCount != null
    ) {
      const indexes = new Set(profile.stackSteps.map((step) => step.stackIndex));
      const invalid = [...indexes].some(
        (index) => index < 1 || index > profile.stackCount!,
      );
      const incomplete = Array.from(
        { length: profile.stackCount },
        (_, index) => index + 1,
      ).some((index) => !indexes.has(index));
      if (invalid || (profile.geometryCertainty === "known" && incomplete)) {
        context.addIssue({
          code: "custom",
          path: ["stackSteps"],
          message:
            "Independent cable geometry needs a valid schedule for every stack.",
        });
      }
    }
    const stepKeys = profile.stackSteps.map(
      (step) => `${step.stackIndex}:${step.stepIndex}`
    );
    if (new Set(stepKeys).size !== stepKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["stackSteps"],
        message: "Each cable stack position may appear only once.",
      });
    }
    if (
      new Set(profile.compatibleAttachmentItemIds).size !==
      profile.compatibleAttachmentItemIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibleAttachmentItemIds"],
        message: "A compatible attachment may be selected only once.",
      });
    }
  });

export const equipmentAttachmentProfileSchema = z.object({
  kind: z.literal("attachment"),
  id: profileId,
  attachmentKind: z.enum([
    "rope",
    "straight_bar",
    "lat_bar",
    "single_handle",
    "v_bar",
    "ankle_cuff",
    "other",
  ]),
  connectionStandard: z.string().trim().min(1).max(120).nullable(),
  status: z.enum(["known", "unknown"]),
});

export const equipmentLoadProfileSchema = z.discriminatedUnion("kind", [
  plateLoadedImplementProfileSchema,
  plateLoadedMachineProfileSchema,
  cableMachineProfileSchema,
  equipmentAttachmentProfileSchema,
]);

export type EquipmentLoadProfile = z.infer<typeof equipmentLoadProfileSchema>;
export type PlateLoadedImplementProfile = z.infer<
  typeof plateLoadedImplementProfileSchema
>;
export type PlateLoadedMachineProfile = z.infer<
  typeof plateLoadedMachineProfileSchema
>;
export type CableMachineProfile = z.infer<typeof cableMachineProfileSchema>;
export type EquipmentAttachmentProfile = z.infer<
  typeof equipmentAttachmentProfileSchema
>;
