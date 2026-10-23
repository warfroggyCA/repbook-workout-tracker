import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  PACKAGE_REVIEW_FILE, PACKAGE_NODE_VERSION, PACKAGE_VERCEL_VERSION,
  verifyReviewedRepository, verifyArchivedSource, validatePackageDestination,
  verifyLocalPackageDependencies,
} from "./lib/packaging-source-policy.mjs";

const root = process.cwd();
const text = readFileSync(PACKAGE_REVIEW_FILE, "utf8");
const context = { env: process.env, event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) };
const review = verifyReviewedRepository(root, text, context);
if (process.platform !== "linux" || process.version !== "v" + PACKAGE_NODE_VERSION) {
  throw new Error("Expected reviewed Linux Node " + PACKAGE_NODE_VERSION);
}
const cliRoot = resolve(".github/toolchains/vercel65/node_modules/vercel");
if (JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")).version !== PACKAGE_VERCEL_VERSION) {
  throw new Error("Expected reviewed Vercel " + PACKAGE_VERCEL_VERSION);
}
const directory = validatePackageDestination(root, process.env.REPBOOK_PACKAGE_DIR, process.env.RUNNER_TEMP);
const originalCache = process.env.NPM_CONFIG_CACHE;
if (originalCache !== "/tmp/repbook-npm-cache" || realpathSync(originalCache) !== resolve(originalCache)
  || !lstatSync(join(originalCache, "_cacache")).isDirectory()) throw new Error("Missing reviewed current-job npm content cache");
function rejectCacheAliases(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error("Untrusted npm cache alias");
  if (info.isDirectory()) for (const name of readdirSync(path)) rejectCacheAliases(join(path, name));
  else if (!info.isFile()) throw new Error("Unsupported npm cache entry");
}
rejectCacheAliases(join(originalCache, "_cacache"));
mkdirSync(directory);
const candidate = join(directory, "candidate");
const reports = join(directory, "reports");
const config = join(directory, "config");
for (const name of [candidate, reports, config, join(directory, "tmp"), join(directory, "cache/npm")]) mkdirSync(name, { recursive: true });
function run(command, args, options = {}) {
  const child = spawnSync(command, args, { stdio: "inherit", ...options });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(command + " failed: " + child.status);
}
writeFileSync(join(config, "npmrc"), "");
writeFileSync(join(config, "global-npmrc"), "");
// Only the content-addressed objects from this fresh trusted job are reused.
// No user configuration, auth files, logs or remote/shared Actions cache is copied.
run("cp", ["-a", join(originalCache, "_cacache"), join(directory, "cache/npm/_cacache")]);
const env = {
  PATH: process.env.PATH,
  TMPDIR: join(directory, "tmp"), TMP: join(directory, "tmp"), TEMP: join(directory, "tmp"),
  XDG_CACHE_HOME: join(directory, "cache"), XDG_CONFIG_HOME: config,
  NODE_COMPILE_CACHE: join(directory, "cache/node"), NPM_CONFIG_CACHE: join(directory, "cache/npm"),
  NPM_CONFIG_USERCONFIG: join(config, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(config, "global-npmrc"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_OFFLINE: "true",
  CI: "1", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1", VERCEL_TELEMETRY_DISABLED: "1",
  VERCEL_CLI_USE_NATIVE_BINARY: "0", DO_NOT_TRACK: "1", VERCEL_ENV: "production",
  AI_FAKE: "1", DATABASE_URL: "", AUTH_SECRET: "local-packaging-only-synthetic-auth-secret",
  AUTH_TRUST_HOST: "true", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
  PGLITE_DIR: join(directory, "synthetic-db"), SNAPSHOT_LOCAL_DIR: join(directory, "synthetic-snapshots"),
};
// A new real audit is mandatory. No candidate opt-in, stale result or ignored failure.
run(process.execPath, [resolve("scripts/check-dependency-audit.mjs")], {
  cwd: root, env: { ...env, NPM_CONFIG_OFFLINE: "false", REPBOOK_AUDIT_REPORT_DIR: join(reports, "dependency-audit") },
});
verifyReviewedRepository(root, text, context);
const archive = join(directory, "source.tar");
run("git", ["archive", "--format=tar", review.head, "-o", archive], { cwd: root });
run("tar", ["-xf", archive, "-C", candidate]);
verifyArchivedSource(candidate, review);
// Reinstall from the frozen lock in the archive. This includes nested file:
// package dependencies; copying root node_modules alone would omit them.
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], { cwd: candidate, env });
const lock = JSON.parse(readFileSync(join(candidate, "package-lock.json"), "utf8"));
const localDependencies = verifyLocalPackageDependencies(candidate, lock);
const tree = spawnSync("npm", ["ls", "--all", "--json"], { cwd: candidate, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
if (tree.error) throw tree.error;
if (tree.status !== 0 || JSON.parse(tree.stdout).problems?.length) throw new Error("Incomplete frozen candidate dependencies");
mkdirSync(join(candidate, ".vercel"));
writeFileSync(join(candidate, ".vercel/project.json"), JSON.stringify({
  projectId: "prj_local_packaging_only", orgId: "team_local_packaging_only",
  projectName: "repbook-local-packaging",
  settings: { framework: "nextjs", nodeVersion: "24.x", rootDirectory: null,
    installCommand: "", buildCommand: "npm run build", outputDirectory: null, createdAt: 0 },
}));
const cli = join(cliRoot, "dist/vc.js");
writeFileSync(join(reports, "toolchain.json"), JSON.stringify({
  node: process.version, platform: process.platform, architecture: process.arch,
  vercel: PACKAGE_VERCEL_VERSION, reviewedCommit: review.manifest.reviewedCommit,
  checkoutCommit: review.head, reviewedSourceSha256: review.snapshot.sha256,
  reviewManifestSha256: review.manifestSha256, reviewExpiresAt: review.manifest.expiresAt,
  appLockSha256: review.appLock, toolLockSha256: review.toolLock,
  sourceArchiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  dependencyTreeSha256: createHash("sha256").update(tree.stdout).digest("hex"), localDependencies,
  limitations: ["Local Linux package, no deployment or remote project settings/secrets",
    "Synthetic environment; environment-specific runtime paths not exercised",
    "No physical-phone recovery acceptance", "Opaque non-JavaScript binary contents not semantically analyzed"],
}, null, 2) + "\n");
run(process.execPath, [cli, "build", "--prod", "--cwd", candidate, "--global-config", config], { cwd: candidate, env });
run("python3", [resolve("scripts/inspect-candidate-functions.py"), candidate, reports], { env });
for (const name of ["function-inventory.json", "summary.json"]) {
  if (!existsSync(join(reports, name))) throw new Error("Missing required function inventory");
}
const summary = JSON.parse(readFileSync(join(reports, "summary.json"), "utf8"));
if (!Number.isInteger(summary.bundles) || summary.bundles < 1 || summary.problems?.length !== 0) {
  throw new Error("Invalid or incomplete function inventory");
}
