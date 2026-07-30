import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  barbellConfigs,
  equipmentItems,
  plateInventory,
  sessionEquipmentSnapshots,
  sessionExercises,
} from "@/db/schema";
import { buildSessionEquipmentConfigurationIdentity } from "@/lib/session-equipment-snapshot-contract";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

/**
 * Creates immutable test evidence that a recorded load meant the ordinary
 * total system load. Production writers must obtain this from the selected
 * equipment flow; characterization fixtures use this helper explicitly so
 * legacy-unknown rows are not mistaken for comparable evidence.
 */
export async function createTotalSystemTestSnapshot(
  db: Db,
  input: {
    userId: string;
    sessionId: string;
    sessionExerciseId: string;
    unit: "lb" | "kg";
    equipmentUnit?: "lb" | "kg";
    label?: string;
    selectAsCurrent?: boolean;
  },
) {
  const label = input.label ?? "Test total-system barbell";
  const equipmentUnit = input.equipmentUnit ?? input.unit;
  const geometrySnapshot = {
    version: 1 as const,
    kind: "plate_loaded_implement" as const,
    loadingKind: "olympic" as const,
    emptyWeight: equipmentUnit === "lb" ? 45 : 20,
    collarWeight: 0,
    unit: equipmentUnit,
    sharedPlatePoolCompatible: true,
    compatiblePlates: [],
  };
  const [equipmentItem] = await db
    .insert(equipmentItems)
    .values({
      userId: input.userId,
      type: "barbell",
      label,
    })
    .returning({ id: equipmentItems.id });
  const [loadProfile] = await db
    .insert(barbellConfigs)
    .values({
      userId: input.userId,
      barType: "olympic",
      equipmentItemId: equipmentItem.id,
      unit: equipmentUnit,
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: equipmentUnit === "lb" ? 45 : 20,
      collarWeight: 0,
      label,
    })
    .returning({ id: barbellConfigs.id });
  await db.insert(plateInventory).values(
    equipmentUnit === "lb"
      ? [
          { userId: input.userId, denomination: 25, unit: "lb", quantity: 2 },
          { userId: input.userId, denomination: 2.5, unit: "lb", quantity: 4 },
        ]
      : [
          { userId: input.userId, denomination: 10, unit: "kg", quantity: 2 },
          { userId: input.userId, denomination: 5, unit: "kg", quantity: 2 },
          { userId: input.userId, denomination: 2.5, unit: "kg", quantity: 2 },
        ],
  );
  const [snapshot] = await db
    .insert(sessionEquipmentSnapshots)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      sessionExerciseId: input.sessionExerciseId,
      equipmentItemId: equipmentItem.id,
      loadProfileId: loadProfile.id,
      equipmentLabel: label,
      profileKind: "plate_loaded_implement",
      geometryCertainty: "known",
      unit: equipmentUnit,
      selectionProvenance: "imported",
      configurationRevision: 1,
      configurationHash: sha256Hex(
        Buffer.from(
          canonicalJson(
            buildSessionEquipmentConfigurationIdentity({
              equipmentItemId: equipmentItem.id,
              equipmentLabel: label,
              equipmentDefinitionKey: null,
              attachmentItemId: null,
              attachmentLabel: null,
              attachmentDefinitionKey: null,
              attachmentKind: null,
              geometry: geometrySnapshot,
            }),
          ),
          "utf8",
        ),
      ),
      geometryVersion: 1,
      geometrySnapshot,
    })
    .returning({ id: sessionEquipmentSnapshots.id });
  if (input.selectAsCurrent) {
    await db
      .update(sessionExercises)
      .set({ currentEquipmentSnapshotId: snapshot.id })
      .where(eq(sessionExercises.id, input.sessionExerciseId));
  }
  return snapshot.id;
}
