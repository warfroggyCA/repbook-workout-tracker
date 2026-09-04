import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const referenceDirectory = join(
  repositoryRoot,
  "docs/assets/active-workout-north-star",
);
const evidenceDirectory = join(
  repositoryRoot,
  "docs/assets/active-workout-phase6-qa",
);
const scenarios = [
  "01-set-entry-390x844-115",
  "02-rest-running-390x844-115",
  "03-rest-complete-390x844-115",
  "04-equipment-conflict-390x844-115",
  "05-set-entry-390x844-145",
  "06-rest-running-390x844-145",
  "07-set-entry-320x700-145",
];

mkdirSync(evidenceDirectory, { recursive: true });

for (const scenario of scenarios) {
  const reference = join(referenceDirectory, `${scenario}.jpg`);
  const implementation = join(evidenceDirectory, `${scenario}.jpg`);
  const comparison = join(evidenceDirectory, `${scenario}-comparison.jpg`);
  for (const input of [reference, implementation]) {
    if (!existsSync(input)) {
      throw new Error(`Cannot build Phase 6 comparison; missing ${input}`);
    }
  }
  const result = spawnSync(
    "magick",
    [reference, implementation, "+append", comparison],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `ImageMagick failed for ${scenario}: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
}

console.log(`Built ${scenarios.length} Phase 6 comparison images.`);
