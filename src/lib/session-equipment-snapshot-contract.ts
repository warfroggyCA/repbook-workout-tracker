import { z } from "zod";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";

const unit = z.enum(["lb", "kg"]);
const storedLoad = z
  .number()
  .finite()
  .min(0)
  .max(MAX_STORED_LOAD)
  .refine((value) => normalizeStoredLoad(value) === value, {
    message: "Load must use no more than two decimal places.",
  })
  .transform(normalizeStoredLoad);
const positiveStoredLoad = storedLoad.pipe(z.number().positive());

export const snapshottedPlateSchema = z.object({
  denomination: positiveStoredLoad,
  quantity: z.number().int().positive().max(1_000),
  unit,
}).strict();

function duplicatePlateKey(
  plates: Array<{ denomination: number; unit: "lb" | "kg" }>,
) {
  const seen = new Set<string>();
  for (const plate of plates) {
    const key = `${plate.unit}:${plate.denomination}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

const snapshotBase = z.object({ version: z.literal(1) }).strict();

export const implementEquipmentGeometrySnapshotSchema = snapshotBase.extend({
  kind: z.literal("plate_loaded_implement"),
  loadingKind: z.enum(["olympic", "ez", "trap_hex", "specialty"]),
  emptyWeight: positiveStoredLoad,
  collarWeight: storedLoad,
  unit,
  sharedPlatePoolCompatible: z.boolean(),
  compatiblePlates: z.array(snapshottedPlateSchema).max(100),
}).superRefine((value, context) => {
  if (duplicatePlateKey(value.compatiblePlates)) {
    context.addIssue({
      code: "custom",
      path: ["compatiblePlates"],
      message: "Compatible plate denominations must be unique.",
    });
  }
  if (value.compatiblePlates.some((plate) => plate.unit !== value.unit)) {
    context.addIssue({
      code: "custom",
      path: ["compatiblePlates"],
      message: "Every compatible plate must use the implement unit.",
    });
  }
  if (!value.sharedPlatePoolCompatible && value.compatiblePlates.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["compatiblePlates"],
      message: "An implement outside the shared plate pool cannot snapshot shared plates.",
    });
  }
});

export const machineEquipmentGeometrySnapshotSchema = snapshotBase.extend({
  kind: z.literal("plate_loaded_machine"),
  geometryCertainty: z.enum(["known", "partial", "unknown"]),
  startingResistance: storedLoad.nullable(),
  startingResistanceUnit: unit.nullable(),
  loadingPointCount: z.number().int().positive().max(16).nullable(),
  balancingRule: z.enum(["single_point", "identical_each_point"]).nullable(),
  targetEntryMeaning: z
    .enum(["total_system", "per_loading_point"])
    .nullable(),
  compatiblePlates: z.array(snapshottedPlateSchema).max(100),
}).superRefine((value, context) => {
  const geometryValues = [
    value.startingResistance,
    value.startingResistanceUnit,
    value.loadingPointCount,
    value.balancingRule,
    value.targetEntryMeaning,
  ];
  const complete = geometryValues.every((entry) => entry != null);
  const empty = geometryValues.every((entry) => entry == null);
  const issue = (path: string, message: string) => context.addIssue({
    code: "custom",
    path: [path],
    message,
  });

  if (value.geometryCertainty === "known" && !complete) {
    issue("geometryCertainty", "Known machine geometry must be complete.");
  }
  if (value.geometryCertainty === "unknown" && !empty) {
    issue("geometryCertainty", "Unknown machine geometry cannot contain asserted geometry.");
  }
  if (value.geometryCertainty === "partial" && (complete || empty)) {
    issue("geometryCertainty", "Partial machine geometry must contain some, but not all, geometry.");
  }
  if ((value.startingResistance == null) !== (value.startingResistanceUnit == null)) {
    issue("startingResistanceUnit", "Starting resistance and its unit must be recorded together.");
  }
  if ((value.loadingPointCount == null) !== (value.balancingRule == null)) {
    issue("balancingRule", "Loading-point count and balancing rule must be recorded together.");
  }
  if (
    value.loadingPointCount != null &&
    value.balancingRule != null &&
    ((value.loadingPointCount === 1) !== (value.balancingRule === "single_point"))
  ) {
    issue("balancingRule", "Single-point balancing must match exactly one loading point.");
  }
  if (duplicatePlateKey(value.compatiblePlates)) {
    issue("compatiblePlates", "Compatible plate denominations must be unique.");
  }
  if (
    value.startingResistanceUnit != null &&
    value.compatiblePlates.some((plate) => plate.unit !== value.startingResistanceUnit)
  ) {
    issue("compatiblePlates", "Every compatible plate must use the machine unit.");
  }
});

export const cableEquipmentGeometrySnapshotSchema = snapshotBase.extend({
  kind: z.literal("cable_machine"),
  geometryCertainty: z.enum(["known", "partial", "unknown"]),
  stackCount: z.number().int().positive().max(16).nullable(),
  topology: z.enum(["shared_selection", "independent_per_stack"]).nullable(),
  displayedUnit: unit.nullable(),
  ratioStatus: z.enum(["known", "unknown"]),
  ratioNumerator: z.number().int().positive().max(10_000).nullable(),
  ratioDenominator: z.number().int().positive().max(10_000).nullable(),
  stackSteps: z.array(z.object({
    stackIndex: z.number().int().min(0).max(16),
    stepIndex: z.number().int().min(0).max(500),
    displayedLoad: storedLoad,
    positionLabel: z.string().trim().min(1).max(80).nullable(),
  }).strict()).max(1_000),
}).superRefine((value, context) => {
  const structural = [value.stackCount, value.topology, value.displayedUnit];
  const complete = structural.every((entry) => entry != null);
  const empty = structural.every((entry) => entry == null);
  const issue = (path: string, message: string) => context.addIssue({
    code: "custom",
    path: [path],
    message,
  });

  if (value.ratioStatus === "known") {
    if (value.ratioNumerator == null || value.ratioDenominator == null) {
      issue("ratioStatus", "A known cable ratio requires both ratio values.");
    }
  } else if (value.ratioNumerator != null || value.ratioDenominator != null) {
    issue("ratioStatus", "An unknown cable ratio cannot contain ratio values.");
  }
  if (value.geometryCertainty === "known" && (!complete || value.stackSteps.length === 0)) {
    issue("geometryCertainty", "Known cable geometry requires complete topology and stack steps.");
  }
  if (
    value.geometryCertainty === "unknown" &&
    (!empty || value.stackSteps.length > 0 || value.ratioStatus !== "unknown")
  ) {
    issue("geometryCertainty", "Unknown cable geometry cannot contain asserted geometry.");
  }
  if (
    value.geometryCertainty === "partial" &&
    empty && value.stackSteps.length === 0 && value.ratioStatus === "unknown"
  ) {
    issue("geometryCertainty", "Partial cable geometry must contain some asserted geometry.");
  }
  if (!complete && value.stackSteps.length > 0) {
    issue("stackSteps", "Stack steps require a complete stack topology.");
  }

  const stepKeys = new Set<string>();
  for (const step of value.stackSteps) {
    const key = `${step.stackIndex}:${step.stepIndex}`;
    if (stepKeys.has(key)) {
      issue("stackSteps", "Stack index and step index pairs must be unique.");
      break;
    }
    stepKeys.add(key);
  }
  if (complete) {
    const allowed = value.topology === "shared_selection"
      ? new Set([0])
      : new Set(Array.from({ length: value.stackCount! }, (_, index) => index + 1));
    const represented = new Set(value.stackSteps.map((step) => step.stackIndex));
    if (value.stackSteps.some((step) => !allowed.has(step.stackIndex))) {
      issue("stackSteps", "Stack steps contain an index outside the recorded topology.");
    }
    if (
      value.geometryCertainty === "known" &&
      [...allowed].some((stackIndex) => !represented.has(stackIndex))
    ) {
      issue("stackSteps", "Known cable geometry requires steps for every stack.");
    }
  }
});

export const sessionEquipmentGeometrySnapshotSchema = z.discriminatedUnion(
  "kind",
  [
    implementEquipmentGeometrySnapshotSchema,
    machineEquipmentGeometrySnapshotSchema,
    cableEquipmentGeometrySnapshotSchema,
  ],
);

export type SessionEquipmentGeometrySnapshot = z.infer<
  typeof sessionEquipmentGeometrySnapshotSchema
>;

export type SessionEquipmentConfigurationIdentityInput = {
  equipmentItemId: string;
  equipmentLabel: string;
  equipmentDefinitionKey: string | null;
  attachmentItemId: string | null;
  attachmentLabel: string | null;
  attachmentDefinitionKey: string | null;
  attachmentKind: string | null;
  geometry: SessionEquipmentGeometrySnapshot;
};

/** The single canonical identity hashed when immutable equipment evidence is created. */
export function buildSessionEquipmentConfigurationIdentity(
  input: SessionEquipmentConfigurationIdentityInput,
) {
  return {
    equipmentItemId: input.equipmentItemId,
    equipmentLabel: input.equipmentLabel,
    equipmentDefinitionKey: input.equipmentDefinitionKey,
    attachmentItemId: input.attachmentItemId,
    attachmentLabel: input.attachmentLabel,
    attachmentDefinitionKey: input.attachmentDefinitionKey,
    attachmentKind: input.attachmentKind,
    geometry: input.geometry,
  };
}
