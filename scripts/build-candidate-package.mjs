import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { CANDIDATE_EXPIRY, REVIEWED_SOURCE_SHA256, fingerprintReviewedSource, validateCandidateContext } from "./lib/candidate-dependency-audit-policy.mjs";
import { createHash } from "node:crypto";
const root = process.cwd();
const policy = JSON.parse(readFileSync("docs/candidate-dependency-audit-exception.json"));
validateCandidateContext(policy, { env: process.env, event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)) });
if (Date.now() >= Date.parse(CANDIDATE_EXPIRY)
  || fingerprintReviewedSource(root).sha256 !== REVIEWED_SOURCE_SHA256) throw new Error("Candidate review expired or source drifted");
if (!process.env.REPBOOK_PACKAGE_DIR) throw new Error("Missing isolated package directory");
const directory = resolve(process.env.REPBOOK_PACKAGE_DIR);
const candidate = join(directory, "candidate");
const reports = join(directory, "reports");
mkdirSync(candidate, { recursive: true });
mkdirSync(reports, { recursive: true });
function run(command, args, options = {}) {
  const child = spawnSync(command, args, { stdio: "inherit", ...options });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(command + " failed: " + child.status);
}
if (process.version !== "v24.18.0") throw new Error("Expected reviewed Node 24.18.0");
run("git", ["archive", "--format=tar", "HEAD", "-o", join(directory, "source.tar")]);
run("tar", ["-xf", join(directory, "source.tar"), "-C", candidate]);
run("cp", ["-a", join(root, "node_modules"), join(candidate, "node_modules")]);
const config = join(directory, "config");
for (const name of [config, join(candidate, ".vercel"), join(directory, "tmp"), join(directory, "cache")]) mkdirSync(name, { recursive: true });
writeFileSync(join(config, "npmrc"), "");
writeFileSync(join(config, "global-npmrc"), "");
writeFileSync(join(candidate, ".vercel/project.json"), JSON.stringify({
  projectId: "prj_local_packaging_only", orgId: "team_local_packaging_only",
  projectName: "repbook-local-packaging",
  settings: { framework: "nextjs", nodeVersion: "24.x", rootDirectory: null,
    installCommand: "", buildCommand: "npm run build", outputDirectory: null, createdAt: 0 },
}));
const env = {
  PATH: process.env.PATH,
  TMPDIR: join(directory, "tmp"), TMP: join(directory, "tmp"), TEMP: join(directory, "tmp"),
  XDG_CACHE_HOME: join(directory, "cache"), XDG_CONFIG_HOME: config,
  NODE_COMPILE_CACHE: join(directory, "cache/node"), NPM_CONFIG_CACHE: join(directory, "cache/npm"),
  NPM_CONFIG_USERCONFIG: join(config, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(config, "global-npmrc"),
  NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_OFFLINE: "true",
  CI: "1", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1", VERCEL_TELEMETRY_DISABLED: "1",
  VERCEL_CLI_USE_NATIVE_BINARY: "0", DO_NOT_TRACK: "1", VERCEL_ENV: "production",
  AI_FAKE: "1", DATABASE_URL: "", AUTH_SECRET: "local-packaging-only-synthetic-auth-secret",
  AUTH_TRUST_HOST: "true", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
  PGLITE_DIR: join(directory, "synthetic-db"), SNAPSHOT_LOCAL_DIR: join(directory, "synthetic-snapshots"),
};
const cli = resolve(".github/toolchains/vercel65/node_modules/vercel/dist/vc.js");
writeFileSync(join(reports, "toolchain.json"), JSON.stringify({
  node: process.version, platform: process.platform, architecture: process.arch,
  vercel: JSON.parse(readFileSync(resolve(".github/toolchains/vercel65/node_modules/vercel/package.json"))).version,
  appLockSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
  toolLockSha256: createHash("sha256").update(readFileSync(".github/toolchains/vercel65/package-lock.json")).digest("hex"),
  sourceArchiveSha256: createHash("sha256").update(readFileSync(join(directory, "source.tar"))).digest("hex"),
  limitations: ["Local Linux package, no deployment or remote project settings/secrets", "Synthetic environment; environment-specific runtime paths not exercised", "No physical-phone recovery acceptance", "Opaque non-JavaScript binary contents not semantically analyzed"],
}, null, 2) + "\n");
run(process.execPath, [cli, "build", "--prod", "--cwd", candidate, "--global-config", config], { cwd: candidate, env });
run("python3", [resolve("scripts/inspect-candidate-functions.py"), candidate, reports]);
