import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  equipmentItems,
  exercises,
  userProfiles,
  users,
} from "@/db/schema";

export const PII01B_SETUP_EMAIL = "pii01b.setup@example.com";

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error("PII-01B setup fixtures require the disposable local PGlite harness.");
  }

  const db = await getDb();
  const existing = await db.query.users.findFirst({
    where: eq(users.email, PII01B_SETUP_EMAIL),
    columns: { id: true },
  });
  if (existing) throw new Error("The PII-01B setup fixture was already seeded.");

  const exercise = await db.query.exercises.findFirst({
    where: eq(exercises.name, "Cable Face Pull"),
    columns: { id: true },
  });
  if (!exercise) throw new Error("Cable Face Pull was not seeded.");

  const [user] = await db
    .insert(users)
    .values({ email: PII01B_SETUP_EMAIL, name: "PII-01B setup reviewer" })
    .returning({ id: users.id });

  await db.insert(userProfiles).values({
    userId: user.id,
    unit: "lb",
    timezone: "America/Toronto",
    setupState: {
      completedSteps: ["profile", "equipment", "constraints", "routine", "coaching"],
      routineDraft: {
        days: [{
          name: "Cable day",
          notes: null,
          warmupNotes: null,
          exercises: [{
            exerciseId: exercise.id,
            name: "Cable Face Pull",
            sets: 3,
            repMin: 12,
            repMax: 15,
            targetLoad: 30,
            targetLoadUnit: "lb",
            restSec: 60,
            supersetGroup: null,
            notes: null,
            warmup: null,
            setNotes: [],
          }],
        }],
      },
    },
  });
  await db.insert(equipmentItems).values({
    userId: user.id,
    type: "cable",
    label: "Setup cable station",
    quantity: 1,
    attrs: {},
    available: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
