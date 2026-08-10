import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

const registry = JSON.parse(
  await readFile(new URL("./production-browser-groups.json", import.meta.url), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const workflow = yaml.load(
  await readFile(
    new URL("../.github/workflows/production-readiness.yml", import.meta.url),
    "utf8",
  ),
);

const failures = [];
const groupNames = [];
const protectedScripts = [];

if (registry.schemaVersion !== 1 || !Array.isArray(registry.groups)) {
  failures.push("production browser registry must use schema version 1 with groups");
} else {
  for (const group of registry.groups) {
    if (!group || typeof group.name !== "string" || !/^[a-z0-9-]+$/.test(group.name)) {
      failures.push("every production browser group needs a stable kebab-case name");
      continue;
    }
    groupNames.push(group.name);
    if (!Array.isArray(group.scripts) || group.scripts.length === 0) {
      failures.push(`${group.name} must contain at least one browser script`);
      continue;
    }
    for (const script of group.scripts) {
      if (typeof script !== "string" || !script.startsWith("test:e2e")) {
        failures.push(`${group.name} contains invalid browser script ${String(script)}`);
        continue;
      }
      protectedScripts.push(script);
      if (typeof packageJson.scripts?.[script] !== "string") {
        failures.push(`${group.name} references missing package script ${script}`);
      }
    }
  }
}

for (const [label, values] of [
  ["group", groupNames],
  ["browser script", protectedScripts],
]) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    failures.push(`duplicate ${label}: ${[...new Set(duplicates)].join(", ")}`);
  }
}

if (
  !Number.isInteger(registry.expectedSuiteCount) ||
  registry.expectedSuiteCount !== protectedScripts.length
) {
  failures.push(
    `protected suite count must remain ${String(registry.expectedSuiteCount)}; found ${protectedScripts.length}`,
  );
}

const workflowGroups = workflow?.jobs?.browser?.strategy?.matrix?.group;
if (!Array.isArray(workflowGroups)) {
  failures.push("production readiness must define the browser group matrix");
} else if (
  [...workflowGroups].sort().join("\n") !== [...groupNames].sort().join("\n")
) {
  failures.push("workflow browser groups must exactly match the protected registry");
}

const browserRuns = workflow?.jobs?.browser?.steps
  ?.map((step) => step?.run)
  .filter((run) => typeof run === "string");
if (
  !Array.isArray(browserRuns) ||
  !browserRuns.includes("npm run build") ||
  !browserRuns.includes('node scripts/run-production-browser-group.mjs "${{ matrix.group }}"')
) {
  failures.push("every protected browser job must build before running its group");
}

const collectorNeeds = workflow?.jobs?.verify?.needs;
const requiredNeeds = ["browser", "core", "postgres-integration"];
if (
  !Array.isArray(collectorNeeds) ||
  [...collectorNeeds].sort().join("\n") !== requiredNeeds.sort().join("\n")
) {
  failures.push("verify must fail closed over browser, core, and PostgreSQL jobs");
}

if (failures.length > 0) {
  throw new Error(`Invalid protected browser routing:\n${failures.join("\n")}`);
}

process.stdout.write(
  `Protected browser routing covers ${protectedScripts.length} suites in ${groupNames.length} parallel groups.\n`,
);
