import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await testFiles("tests")).sort();
const batchSize = Number(process.env.VITEST_BATCH_SIZE ?? 4);
if (!Number.isInteger(batchSize) || batchSize < 1) {
  throw new Error("VITEST_BATCH_SIZE must be a positive integer.");
}
const batches = Array.from(
  { length: Math.ceil(files.length / batchSize) },
  (_, index) => files.slice(index * batchSize, (index + 1) * batchSize)
);
const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

for (const [index, batch] of batches.entries()) {
  process.stdout.write(`\nUnit suite batch ${index + 1}/${batches.length}\n`);
  const result = spawnSync(
    process.execPath,
    [vitest, "run", ...batch, `--maxWorkers=${batch.length}`, ...process.argv.slice(2)],
    { cwd: process.cwd(), env: process.env, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`\nAll ${files.length} unit test files passed in ${batches.length} isolated batches.\n`);
