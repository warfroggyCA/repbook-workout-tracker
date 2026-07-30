import fs from "node:fs/promises";

const SOURCE_URL =
  "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
const OUTPUT = new URL("../src/data/extended-exercise-catalog.json", import.meta.url);

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Exercise catalog download failed: ${response.status}`);
}

const source = await response.json();
if (!Array.isArray(source) || source.length < 800) {
  throw new Error("Exercise catalog source did not contain the expected records.");
}

const catalog = source
  .map((exercise) => ({
    source: "free-exercise-db",
    sourceId: String(exercise.id),
    sourceUrl: `https://github.com/yuhonas/free-exercise-db/blob/main/exercises/${exercise.id}.json`,
    license: "Unlicense",
    name: String(exercise.name).trim(),
    equipment: exercise.equipment == null ? null : String(exercise.equipment),
    primaryMuscles: Array.isArray(exercise.primaryMuscles)
      ? exercise.primaryMuscles.map(String)
      : [],
    secondaryMuscles: Array.isArray(exercise.secondaryMuscles)
      ? exercise.secondaryMuscles.map(String)
      : [],
    category: exercise.category == null ? null : String(exercise.category),
    force: exercise.force == null ? null : String(exercise.force),
    mechanic: exercise.mechanic == null ? null : String(exercise.mechanic),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

await fs.writeFile(OUTPUT, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`extended exercise catalog: ${catalog.length} metadata records`);
