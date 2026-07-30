import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { getDb } from "@/db";
import { seedExerciseLibrary } from "./library";
import { seedTrustedExerciseMedia } from "./exercise-media";
import { seedDemo } from "./demo";

async function main() {
  const withDemo = process.argv.includes("--demo");
  const db = await getDb();

  const { inserted } = await seedExerciseLibrary(db);
  console.log(`exercise library: ${inserted} inserted`);
  const media = await seedTrustedExerciseMedia(db);
  console.log(
    `exercise media: ${media.assets} assets, ${media.associations} associations`
  );
  if (media.missingExercises.length > 0) {
    throw new Error(
      `Trusted media exercises are missing: ${media.missingExercises.join(", ")}`
    );
  }

  if (withDemo) {
    const localDb = db as typeof db & {
      transaction<T>(work: (tx: typeof db) => Promise<T>): Promise<T>;
    };
    if (typeof localDb.transaction !== "function") {
      throw new Error("Demo seeding requires the local transactional database.");
    }
    console.log(await localDb.transaction((tx) => seedDemo(tx)));
  }

  // PGlite needs an explicit close to flush to disk before process exit.
  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  if (client?.close) await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
