import { mkdtemp, rm, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveE2EServerHostname } from "./e2e-server-hostname.mjs";

const production = process.argv.includes("--production");
const baFixture = process.argv.includes("--ba-fixture");
const baRoutineChange = process.argv.includes("--ba-routine-change");
const stage6Simulation = process.argv.includes("--stage6-simulation");
const stage7Ux = process.argv.includes("--stage7-ux");
const phase0Start = process.argv.includes("--phase0-start");
const phase1Foundation = process.argv.includes("--phase1-foundation");
const baCalendar = process.argv.includes("--ba-calendar");
const plateMachineGuidance = process.argv.includes("--plate-machine-guidance");
const optimizedRouteFixtures = process.argv.includes(
  "--optimized-route-fixtures",
);
const programEditorDisabled = process.argv.includes(
  "--program-editor-disabled",
);
const v2H01History = process.argv.includes("--v2-h01-history");
const v2H02Cadence = process.argv.includes("--v2-h02-cadence-targets-time");
const v2H03Evidence = process.argv.includes("--v2-h03-evidence-identity");
const v2H04Pain = process.argv.includes("--v2-h04-pain-consistency");
const v2H05Review = process.argv.includes("--v2-h05-evidence-linked-review");
const v2GauntletBLiveWorkout = process.argv.includes("--v2-gauntlet-b-live-workout");
const v2A01AnalysisPackage = process.argv.includes("--v2-a01-analysis-package");
const pii01bEquipmentFit = process.argv.includes("--pii01b-equipment-fit");
const port = Number.parseInt(process.env.E2E_PORT ?? "3100", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("E2E_PORT must be an integer from 1024 through 65535.");
}
const hostname = resolveE2EServerHostname(process.env.E2E_HOSTNAME);
if (baCalendar) {
  const start = process.env.BA_ACCEPTANCE_START_AT ?? "";
  const finish = process.env.BA_ACCEPTANCE_FINISH_AT ?? "";
  const validIso = (value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  };
  if (!validIso(start) || !validIso(finish) || Date.parse(finish) < Date.parse(start)) {
    throw new Error(
      "BA calendar mode requires ordered exact UTC ISO start and finish instants.",
    );
  }
}
if (
  baRoutineChange &&
  process.env.BA_ROUTINE_CHANGE_FAILURE_MODE &&
  !["timeout", "malformed", "unavailable"].includes(
    process.env.BA_ROUTINE_CHANGE_FAILURE_MODE,
  )
) {
  throw new Error("Unknown deterministic BA routine-build failure mode.");
}
if (stage6Simulation && !baRoutineChange) {
  throw new Error("Stage 6 simulation fixtures require BA routine-change mode.");
}
if (
  (v2H01History || v2H02Cadence || v2H03Evidence || v2H04Pain || v2H05Review || v2GauntletBLiveWorkout || v2A01AnalysisPackage) &&
  [
    v2H01History && v2H02Cadence,
    v2H01History && v2H03Evidence,
    v2H02Cadence && v2H03Evidence,
    v2H01History && v2H04Pain,
    v2H02Cadence && v2H04Pain,
    v2H03Evidence && v2H04Pain,
    v2H01History && v2H05Review,
    v2H02Cadence && v2H05Review,
    v2H03Evidence && v2H05Review,
    v2H04Pain && v2H05Review,
    v2H01History && v2GauntletBLiveWorkout,
    v2H02Cadence && v2GauntletBLiveWorkout,
    v2H03Evidence && v2GauntletBLiveWorkout,
    v2H04Pain && v2GauntletBLiveWorkout,
    v2H05Review && v2GauntletBLiveWorkout,
    v2H01History && v2A01AnalysisPackage,
    v2H02Cadence && v2A01AnalysisPackage,
    v2H03Evidence && v2A01AnalysisPackage,
    v2H04Pain && v2A01AnalysisPackage,
    v2H05Review && v2A01AnalysisPackage,
    v2GauntletBLiveWorkout && v2A01AnalysisPackage,
    baFixture,
    baRoutineChange,
    stage6Simulation,
    stage7Ux,
    phase0Start,
    phase1Foundation,
    baCalendar,
    plateMachineGuidance,
    optimizedRouteFixtures,
    programEditorDisabled,
  ].some(Boolean)
) {
  throw new Error("Dedicated v2 fixtures cannot be combined with another fixture mode.");
}
if (
  (baFixture || baRoutineChange || baCalendar) &&
  (
    optimizedRouteFixtures ||
    programEditorDisabled ||
    [baFixture, baRoutineChange, baCalendar].filter(Boolean).length !== 1
  )
) {
  throw new Error("A BA fixture mode cannot be combined with another fixture mode.");
}
if (!production) {
  // Browser acceptance needs a clean webpack development cache. Reusing `.next`
  // across production builds or repeated dev-server lifetimes can leave route
  // manifests incompatible or partially written.
  await rm(join(process.cwd(), ".next"), { recursive: true, force: true });
}
const created = spawnSync(
  process.execPath,
  ["scripts/create-disposable-db.mjs", "--mode=fresh"],
  { cwd: process.cwd(), encoding: "utf8" },
);
if (created.error) throw created.error;
if (created.status !== 0) {
  throw new Error(created.stderr || "Could not create the E2E database.");
}

const creationLine = created.stdout.trim().split("\n").at(-1);
if (!creationLine)
  throw new Error("Disposable database path was not returned.");
const { pgliteDir } = JSON.parse(creationLine);
const snapshotDir = await mkdtemp(
  join(tmpdir(), "workout-tracker-e2e-snapshots-"),
);
let developmentBuildDir;
async function cleanupResources() {
  const cleanup = [
    rm(pgliteDir, { recursive: true, force: true }),
    rm(snapshotDir, { recursive: true, force: true }),
  ];
  if (developmentBuildDir) {
    cleanup.push(
      rm(join(process.cwd(), ".next"), { recursive: true, force: true }),
      rm(developmentBuildDir, { recursive: true, force: true }),
    );
  }
  await Promise.all(cleanup);
}
const environment = {
  ...process.env,
  AI_FAKE: "1",
  ANTHROPIC_API_KEY: "",
  ALLOWED_EMAILS: v2GauntletBLiveWorkout
    ? "ba.iphone.e2e@example.com"
    : v2A01AnalysisPackage
    ? "v2.h01.history.e2e@example.com"
    : v2H05Review
    ? "review-decisions.e2e@example.com"
    : v2H02Cadence
    ? "v2.h02.cadence.e2e@example.com"
    : v2H01History || v2H03Evidence || v2H04Pain
      ? "v2.h01.history.e2e@example.com"
    : baFixture || baCalendar
      ? "ba.iphone.e2e@example.com"
      : baRoutineChange
        ? "ba.routine-change.e2e@example.com"
        : "owner@example.com,second.e2e@example.com,program-page.e2e@example.com,today-empty.e2e@example.com,history-calendar.e2e@example.com,history-workspace-sparse.e2e@example.com,review-decisions.e2e@example.com,equipment-onboarding.e2e@example.com",
  AUTH_SECRET: "local-e2e-secret-not-used-outside-this-process",
  AUTH_TRUST_HOST: "true",
  BA_FIXTURE_MODE: baFixture || baRoutineChange || baCalendar || v2GauntletBLiveWorkout ? "1" : "",
  BA_CALENDAR_MODE: baCalendar ? "1" : "",
  BA_ACCEPTANCE_START_AT: baCalendar
    ? process.env.BA_ACCEPTANCE_START_AT ?? ""
    : "",
  BA_ACCEPTANCE_FINISH_AT: baCalendar
    ? process.env.BA_ACCEPTANCE_FINISH_AT ?? ""
    : "",
  BA_ROUTINE_CHANGE_FIXTURE: baRoutineChange ? "1" : "",
  BA_ROUTINE_CHANGE_FAILURE_MODE: baRoutineChange
    ? process.env.BA_ROUTINE_CHANGE_FAILURE_MODE ?? ""
    : "",
  STAGE6_SIMULATION_FIXTURE: stage6Simulation ? "1" : "",
  STAGE7_UX_FIXTURE: stage7Ux ? "1" : "",
  PHASE0_START_FIXTURE: phase0Start ? "1" : "",
  PHASE1_FOUNDATION_FIXTURE: phase1Foundation ? "1" : "",
  PLATE_MACHINE_GUIDANCE_FIXTURE: plateMachineGuidance ? "1" : "",
  V2_H05_REVIEW_FIXTURE: v2H05Review ? "1" : "",
  DATABASE_URL: "",
  E2E_DEV_LOGIN: "1",
  MAINTENANCE_SECRET: "local-e2e-maintenance-secret",
  NEXT_TELEMETRY_DISABLED: "1",
  OPENAI_API_KEY: "",
  PGLITE_DIR: pgliteDir,
  PROGRAM_EDITOR_ENABLED: programEditorDisabled ? "false" : "true",
  PROGRAM_TEXT_IMPORT_ENABLED:
    process.env.PROGRAM_TEXT_IMPORT_ENABLED ?? "",
  SESSION_COMPILER_ENABLED: programEditorDisabled ? "false" : "true",
  SETTINGS_MANAGEMENT_ENABLED: "true",
  SNAPSHOT_ENCRYPTION_KEY_V1: Buffer.alloc(32, 17).toString("base64"),
  SNAPSHOT_ENCRYPTION_KEY_VERSION: "v1",
  SNAPSHOT_LOCAL_DIR: snapshotDir,
  WATCHPACK_POLLING: "true",
};
const serverScriptEnvironment = {
  ...environment,
  NODE_OPTIONS: [environment.NODE_OPTIONS, "--conditions=react-server"]
    .filter(Boolean)
    .join(" "),
};

const seeded = spawnSync(
  "npm",
  baFixture || baRoutineChange || baCalendar || v2H01History || v2H02Cadence || v2H03Evidence || v2H04Pain || v2GauntletBLiveWorkout || v2A01AnalysisPackage
    ? ["run", "db:seed"]
    : ["run", "db:seed", "--", "--demo"],
  {
  cwd: process.cwd(),
  env: serverScriptEnvironment,
  stdio: "inherit",
  },
);
if (seeded.error) {
  await Promise.all([
    rm(pgliteDir, { recursive: true, force: true }),
    rm(snapshotDir, { recursive: true, force: true }),
  ]);
  throw seeded.error;
}
if (seeded.status !== 0) {
  await rm(pgliteDir, { recursive: true, force: true });
  await rm(snapshotDir, { recursive: true, force: true });
  throw new Error(`E2E seed failed with status ${seeded.status}.`);
}

const fixtures = v2A01AnalysisPackage
  ? [{ label: "A01 analysis package", script: "tests/helpers/seed-v2-a01-analysis-package.ts" }]
  : v2GauntletBLiveWorkout
  ? [
      { label: "BA workout", script: "tests/helpers/seed-ba-workout.ts" },
      {
        label: "Gauntlet B unavailable-equipment workout",
        script: "tests/helpers/seed-v2-gauntlet-b-live-workout.ts",
      },
    ]
  : v2H05Review
  ? [{ label: "H05 evidence-linked Review", script: "tests/helpers/seed-review-decisions.ts" }]
  : v2H04Pain
  ? [
      {
        label: "H04 pain consistency",
        script: "tests/helpers/seed-v2-h04-pain-consistency.ts",
      },
    ]
  : v2H03Evidence
  ? [{
      label: "H03 exercise evidence",
      script: "tests/helpers/seed-v2-h01-history.ts",
    }]
  : v2H02Cadence
    ? [{
      label: "H02 cadence and targets",
      script: "tests/helpers/seed-v2-h02-cadence-targets-time.ts",
    }]
  : v2H01History
    ? [{ label: "H01 performed-first History", script: "tests/helpers/seed-v2-h01-history.ts" }]
  : plateMachineGuidance
  ? [{
      label: "Plate-machine guidance",
      script: "tests/helpers/seed-plate-machine-guidance.ts",
    }]
  : baFixture || baCalendar
    ? [{ label: "BA workout", script: "tests/helpers/seed-ba-workout.ts" }]
    : baRoutineChange
    ? [
        { label: "BA routine change", script: "tests/helpers/seed-ba-routine-change.ts" },
        ...(stage6Simulation
          ? [{ label: "Stage 6 simulation equipment", script: "tests/helpers/seed-stage6-simulation-equipment.ts" }]
          : []),
      ]
  : pii01bEquipmentFit
  ? [{ label: "PII-01B setup review", script: "tests/helpers/seed-pii01b-setup-review.ts" }]
  : [
      ...(stage7Ux
        ? [{ label: "Stage 7 UX", script: "tests/helpers/seed-stage7-ux.ts" }]
        : []),
      {
        label: "Progression recovery",
        script: "tests/helpers/seed-progression-recovery.ts",
      },
      {
        label: "Program page repair",
        script: "tests/helpers/seed-program-page-repair.ts",
      },
      { label: "Empty Today", script: "tests/helpers/seed-today-empty.ts" },
      { label: "Review decision", script: "tests/helpers/seed-review-decisions.ts" },
    ];

for (const fixture of fixtures) {
  const result = spawnSync("npx", ["tsx", fixture.script], {
    cwd: process.cwd(),
    env: serverScriptEnvironment,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    await Promise.all([
      rm(pgliteDir, { recursive: true, force: true }),
      rm(snapshotDir, { recursive: true, force: true }),
    ]);
    if (result.error) throw result.error;
    throw new Error(
      `${fixture.label} fixture seed failed with status ${result.status}.`,
    );
  }
}

if (!production) {
  try {
    developmentBuildDir = await mkdtemp(
      join(tmpdir(), "workout-tracker-e2e-next-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(developmentBuildDir, "node_modules"),
      "dir",
    );
    await symlink(developmentBuildDir, join(process.cwd(), ".next"), "dir");
  } catch (error) {
    await cleanupResources();
    throw error;
  }
}

if (production && optimizedRouteFixtures) {
  const routeFixtures = spawnSync(
    "npx",
    ["tsx", "tests/helpers/seed-optimized-route-fixtures.ts"],
    {
      cwd: process.cwd(),
      env: serverScriptEnvironment,
      stdio: "inherit",
    },
  );
  if (routeFixtures.error) {
    await Promise.all([
      rm(pgliteDir, { recursive: true, force: true }),
      rm(snapshotDir, { recursive: true, force: true }),
    ]);
    throw routeFixtures.error;
  }
  if (routeFixtures.status !== 0) {
    await Promise.all([
      rm(pgliteDir, { recursive: true, force: true }),
      rm(snapshotDir, { recursive: true, force: true }),
    ]);
    throw new Error(
      `Optimized route fixture seed failed with status ${routeFixtures.status}.`,
    );
  }
}

const server = spawn(
  process.execPath,
  production
    ? [
        "--import",
        "./tests/helpers/pglite-neon-fetch.mjs",
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        hostname,
        "--port",
        String(port),
      ]
    : [
        "node_modules/next/dist/bin/next",
        "dev",
        "--webpack",
        "--hostname",
        hostname,
        "--port",
        String(port),
      ],
  {
    cwd: process.cwd(),
    env: {
      ...environment,
      ...(production
        ? {
            DATABASE_URL:
              "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test",
          }
        : {}),
    },
    stdio: "inherit",
  },
);

let stopping = false;
async function stop(exitCode, signal) {
  if (stopping) return;
  stopping = true;
  if (server.exitCode == null && server.signalCode == null) {
    server.kill(signal ?? "SIGTERM");
    await once(server, "exit");
  }
  await cleanupResources();
  process.exit(exitCode);
}

process.on("SIGINT", () => void stop(130, "SIGINT"));
process.on("SIGTERM", () => void stop(143, "SIGTERM"));
server.on("error", (error) => {
  console.error(error);
  void stop(1);
});
server.on("exit", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  void stop(exitCode);
});
