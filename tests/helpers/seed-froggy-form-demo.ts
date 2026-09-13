import { and, eq, isNull } from "drizzle-orm";
import { matchFroggyFormDemo } from "@/lib/froggy-form-demo";
import { getDb } from "@/db";
import { exercises, users } from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL ||
      process.env.E2E_DEV_LOGIN !== "1" || process.env.FROGGY_FORM_DEMO_PILOT !== "true") {
    throw new Error("Froggy fixture requires the disposable E2E database and explicit pilot flag.");
  }
  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(users.email, "owner@example.com") });
  if (!user) throw new Error("Synthetic demo owner must be seeded first.");
  const variants = ["incline_dumbbell_curl", "incline_barbell_bench_press", "wide_grip_lat_pulldown", "kettlebell_goblet_squat", "romanian_deadlift", "barbell_bench_press", "barbell_back_squat", "barbell_overhead_press", "barbell_row", "bulgarian_split_squat", "ez_bar_curl", "cable_leg_curl", "triceps_pushdown", "chest_supported_dumbbell_row", "chest_supported_dumbbell_reverse_fly", "single_leg_dumbbell_calf_raise", "dead_bug", "zottman_curl", "kettlebell_suitcase_carry", "dumbbell_lateral_raise", "dumbbell_bench_press"];
  const supported = await Promise.all(variants.map(key => db.query.exercises.findFirst({
    where: and(isNull(exercises.userId), eq(exercises.variantKey, key)),
  })));
  const row = await db.query.exercises.findFirst({ where: and(isNull(exercises.userId), eq(exercises.name, "Dumbbell Row")) });
  if (supported.some(e => !e || !matchFroggyFormDemo(e, true)) || !row) throw new Error("Required synthetic catalog exercises are missing.");
  const result = await activateProgramAtomically(db, {
    userId: user.id, loadUnit: "lb", programName: "Exercise form preview",
    changeSummary: "Disposable form viewer fixture", auditAction: "program.activate",
    auditSummary: "Synthetic form viewer test only",
    days: [[...supported.slice(0, 5), row], supported.slice(5, 9), supported.slice(9, 11), supported.slice(11, 15), supported.slice(15, 19), supported.slice(19)].map((items, index) => ({ name: `Day ${index + 1} — Form practice`, notes: "Synthetic local preview", exercises: items.map(exercise => ({
      exerciseId: exercise!.id, sets: 3, repMin: 8, repMax: 12, targetLoad: exercise!.loadType === "bodyweight" ? 0 : exercise!.loadType === "barbell" ? 45 : 15, restSec: 90,
      supersetKey: null, notes: null, warmupNotes: null, warmupSets: [],
    })) })),
  });
  if (!result.ok) throw new Error(`Fixture activation failed: ${result.reason}`);
  await (db as { $client?: { close?: () => Promise<void> } }).$client?.close?.();
  console.log("Froggy synthetic Program ready for owner@example.com.");
}
void main().catch(error => { console.error(error); process.exit(1); });
