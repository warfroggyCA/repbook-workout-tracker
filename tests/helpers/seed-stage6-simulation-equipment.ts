import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  barbellConfigs,
  cableAttachmentCompatibilities,
  cableAttachmentProfiles,
  cableMachineProfiles,
  cableStackSteps,
  equipmentItems,
  users,
} from "@/db/schema";
import { BA_ROUTINE_CHANGE_EMAIL } from "../fixtures/ba-routine-change-contract";

async function main() {
  if (
    process.env.BA_ROUTINE_CHANGE_FIXTURE !== "1" ||
    process.env.STAGE6_SIMULATION_FIXTURE !== "1" ||
    process.env.E2E_DEV_LOGIN !== "1" ||
    !process.env.PGLITE_DIR
  ) {
    throw new Error("Stage 6 equipment augmentation requires the disposable BA acceptance runtime.");
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    const user = await tx.query.users.findFirst({
      where: eq(users.email, BA_ROUTINE_CHANGE_EMAIL),
    });
    if (!user) throw new Error("The Stage 6 BA fixture owner is missing.");
    const items = await tx.query.equipmentItems.findMany({
      where: eq(equipmentItems.userId, user.id),
    });
    const olympic = items.find((item) => item.type === "barbell");
    const ez = items.find((item) => item.type === "ez_bar");
    const cable = items.find((item) => item.type === "cable");
    if (!olympic || !ez || !cable) {
      throw new Error("The Stage 6 BA fixture equipment is incomplete.");
    }

    await tx.update(barbellConfigs).set({
      equipmentItemId: olympic.id,
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
    }).where(and(eq(barbellConfigs.userId, user.id), eq(barbellConfigs.barType, "olympic")));
    await tx.update(barbellConfigs).set({
      equipmentItemId: ez.id,
      unit: "lb",
      loadingKind: "ez",
      sharedPlatePoolCompatible: true,
    }).where(and(eq(barbellConfigs.userId, user.id), eq(barbellConfigs.barType, "ez")));

    const [latBar] = await tx.insert(equipmentItems).values({
      userId: user.id,
      type: "other",
      label: "Lat bar attachment",
      attrs: {},
      available: true,
    }).returning({ id: equipmentItems.id });
    if (!latBar) throw new Error("The Stage 6 lat-bar item was not created.");
    const [cableProfile] = await tx.insert(cableMachineProfiles).values({
      userId: user.id,
      equipmentItemId: cable.id,
      geometryCertainty: "known",
      stackCount: 1,
      topology: "shared_selection",
      displayedUnit: "lb",
      ratioStatus: "known",
      ratioNumerator: 1,
      ratioDenominator: 1,
    }).returning({ id: cableMachineProfiles.id });
    const [latBarProfile] = await tx.insert(cableAttachmentProfiles).values({
      userId: user.id,
      equipmentItemId: latBar.id,
      attachmentKind: "lat_bar",
      connectionStandard: "fixture-compatible",
      status: "known",
    }).returning({ id: cableAttachmentProfiles.id });
    if (!cableProfile || !latBarProfile) {
      throw new Error("The Stage 6 cable profiles were not created.");
    }
    await tx.insert(cableAttachmentCompatibilities).values({
      userId: user.id,
      cableProfileId: cableProfile.id,
      attachmentProfileId: latBarProfile.id,
    });
    await tx.insert(cableStackSteps).values(
      Array.from({ length: 21 }, (_, stepIndex) => ({
        userId: user.id,
        cableProfileId: cableProfile.id,
        stackIndex: 0,
        stepIndex,
        positionLabel: stepIndex === 0 ? "Top" : null,
        displayedLoad: stepIndex * 5,
      })),
    );
  });
}

void main();
