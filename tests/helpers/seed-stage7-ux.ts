import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { getDb } from "@/db";
import { exercises, importEvents, users } from "@/db/schema";

const ownerEmail = "owner@example.com";
const exerciseName = "Barbell Bench Press";

async function main() {
  if (
    process.env.STAGE7_UX_FIXTURE !== "1" ||
    process.env.AI_FAKE !== "1" ||
    process.env.E2E_DEV_LOGIN !== "1" ||
    !process.env.PGLITE_DIR ||
    process.env.DATABASE_URL
  ) {
    throw new Error(
      "Stage 7 UX fixtures require the explicit disposable local harness.",
    );
  }

  const temporaryRoot = resolve(tmpdir());
  const databaseDirectory = resolve(process.env.PGLITE_DIR);
  const fromTemporaryRoot = relative(temporaryRoot, databaseDirectory);
  if (
    !fromTemporaryRoot ||
    fromTemporaryRoot === ".." ||
    fromTemporaryRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(temporaryRoot, fromTemporaryRoot) !== databaseDirectory ||
    !basename(databaseDirectory).startsWith("workout-tracker-fresh-")
  ) {
    throw new Error(
      "Stage 7 UX fixtures require a fresh workout-tracker-fresh-* database inside the operating-system temporary directory.",
    );
  }

  const db = await getDb();
  const owner = await db.query.users.findFirst({
    where: eq(users.email, ownerEmail),
  });
  const exercise = await db.query.exercises.findFirst({
    where: eq(exercises.name, exerciseName),
  });
  if (!owner || !exercise) {
    throw new Error("The Stage 7 UX owner or exercise was not seeded.");
  }

  await db.insert(importEvents).values({
    userId: owner.id,
    source: "paste",
    rawPayload: "Stage 7 deterministic routine-import sizing fixture",
    status: "parsed",
    parsedPayload: {
      envelope: {
        data: {
          programName: "Stage 7 import review",
          days: [
            {
              name: "Day 1 — Full Body",
              order: 0,
              exercises: [
                {
                  rawName: exerciseName,
                  sets: 3,
                  reps: { kind: "range", min: 8, max: 8 },
                  load: 95,
                  loadUnit: "lb",
                  restSec: 120,
                  supersetKey: null,
                  notes: "Deterministic Stage 7 sizing evidence.",
                },
              ],
            },
          ],
        },
        confidence: 1,
        ambiguities: [],
        clarifyingQuestions: [],
        unparsed: [],
      },
      mappings: [
        {
          rawName: exerciseName,
          exerciseId: exercise.id,
          matchType: "exact",
          candidates: [
            { id: exercise.id, name: exerciseName, why: "Exact fixture match" },
          ],
        },
      ],
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
