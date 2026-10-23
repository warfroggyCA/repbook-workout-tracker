import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

export const PACKAGE_REVIEW_FILE = "docs/reviewed-package-source.json";
export const PACKAGE_REVIEW_EXPIRY = "2026-10-28T12:30:00.000Z";
export const PACKAGE_NODE_VERSION = "24.18.0";
export const PACKAGE_VERCEL_VERSION = "65.0.0";
const PACKAGE_IDENTITY = Object.freeze({
  repositorySha256: "e26106dc948c7d3be09af63e048d9c86a647956ed655784d224f7c3b8175ff4f",
  ownerLoginSha256: "ad32d1befd338793d04d41362b1565145cf757b6b5d26471b652b48949f20e8b",
  repositoryId: 1317195955, ownerId: 132015621,
});
const branch = "codex/one-next-move-public-review";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value, length) => typeof value === "string" && new RegExp("^[0-9a-f]{" + length + "}$").test(value);
const inside = (parent, child) => {
  const name = relative(parent, child);
  return name === "" || (!name.startsWith(".." + sep) && name !== ".." && !isAbsolute(name));
};
export function git(root, args) {
  const child = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20_000 });
  if (child.error) throw child.error;
  assert(child.status === 0, "Packaging Git verification failed.");
  return child.stdout;
}
function safePath(name) {
  assert(typeof name === "string" && name.length > 0 && !isAbsolute(name)
    && !name.includes("\\") && !/[\u0000-\u001f]/.test(name)
    && !name.split("/").some((part) => part === ".." || part === "" || part === "."),
  "Unsafe packaging source path.");
  return name;
}
function regular(root, name, mode) {
  safePath(name);
  const file = resolve(root, name);
  assert(inside(root, file), "Packaging source escapes checkout.");
  const info = lstatSync(file);
  assert(realpathSync(file) === file, "Packaging source path contains an alias.");
  assert(info.isFile() && !info.isSymbolicLink(), "Packaging source must be a regular file.");
  assert((info.mode & 0o111 ? "100755" : "100644") === mode, "Packaging executable mode drift.");
  return { path: name, mode, sha256: sha(readFileSync(file)) };
}
function digest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(entry.path + "\0" + entry.mode + "\0" + entry.sha256 + "\n");
  return hash.digest("hex");
}
export function fingerprintPackageSource(root) {
  root = realpathSync(root);
  const entries = [];
  for (const record of git(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) [0-9a-f]+ 0\t([\s\S]+)$/.exec(record);
    assert(match && ["100644", "100755"].includes(match[1]), "Unsupported or unmerged packaging source.");
    const [, mode, name] = match;
    if (name === PACKAGE_REVIEW_FILE) continue;
    entries.push(regular(root, name, mode));
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert(entries.length > 0, "Empty packaging source inventory.");
  return { sha256: digest(entries), fileCount: entries.length, entries };
}
export function validatePackageManifest(text, now = new Date()) {
  const manifest = JSON.parse(text);
  assert(text === JSON.stringify(manifest, null, 2) + "\n", "Packaging manifest must be canonical and unambiguous.");
  const keys = ["schemaVersion", "purpose", "status", "reviewedCommit", "sourceSha256", "sourceFileCount",
    "appLockSha256", "toolLockSha256", "expiresAt", "nodeVersion", "vercelVersion"];
  assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(keys.sort()), "Unexpected packaging manifest fields.");
  assert(manifest.schemaVersion === 1 && manifest.purpose === "local-deployment-package-review"
    && manifest.status === "reviewed", "Packaging source has not completed review.");
  assert(hex(manifest.reviewedCommit, 40) && hex(manifest.sourceSha256, 64)
    && hex(manifest.appLockSha256, 64) && hex(manifest.toolLockSha256, 64)
    && Number.isSafeInteger(manifest.sourceFileCount) && manifest.sourceFileCount > 0, "Invalid packaging review identity.");
  assert(manifest.expiresAt === PACKAGE_REVIEW_EXPIRY && Number.isFinite(now.getTime())
    && now.getTime() < Date.parse(PACKAGE_REVIEW_EXPIRY), "Packaging review expired or expiry changed.");
  assert(manifest.nodeVersion === PACKAGE_NODE_VERSION && manifest.vercelVersion === PACKAGE_VERCEL_VERSION,
    "Unreviewed packaging toolchain.");
  return manifest;
}
// The production entry point always uses the immutable reviewed identity.
// The pure validator also permits synthetic identities in isolated unit fixtures.
export function validatePackageContext(env, event) {
  return validateHostedPackageContext(env, event, PACKAGE_IDENTITY);
}
export function validateHostedPackageContext(env, event, identity) {
  const { repositoryId, ownerId } = identity;
  const repository = env.GITHUB_REPOSITORY;
  const pr = event?.pull_request;
  assert(env.CI === "true" && env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted"
    && env.RUNNER_OS === "Linux", "Packaging requires trusted hosted Linux CI.");
  assert(env.GITHUB_EVENT_NAME === "pull_request" && event.number === 140
    && env.GITHUB_REF === "refs/pull/140/merge", "Packaging requires the reviewed PR merge context.");
  assert(typeof repository === "string" && sha(Buffer.from(repository)) === identity.repositorySha256
    && typeof env.GITHUB_REPOSITORY_OWNER === "string"
    && sha(Buffer.from(env.GITHUB_REPOSITORY_OWNER)) === identity.ownerLoginSha256
    && env.GITHUB_ACTOR === env.GITHUB_REPOSITORY_OWNER && env.GITHUB_TRIGGERING_ACTOR === env.GITHUB_REPOSITORY_OWNER
    && String(env.GITHUB_REPOSITORY_OWNER_ID) === String(ownerId), "Packaging requires the reviewed owner.");
  for (const repo of [event.repository, pr?.head?.repo, pr?.base?.repo]) {
    assert(repo?.id === repositoryId && repo.full_name === repository && repo.private === false,
      "Packaging rejects fork or repository drift.");
  }
  assert(event.repository.owner?.id === ownerId && event.sender?.id === ownerId && pr?.user?.id === ownerId
    && pr.author_association === "OWNER", "Packaging owner identity drift.");
  assert(env.GITHUB_HEAD_REF === branch && pr.head.ref === branch && env.GITHUB_BASE_REF === "main"
    && pr.base.ref === "main", "Packaging branch drift.");
  assert(env.GITHUB_WORKFLOW_REF?.split("@")[0] === repository + "/.github/workflows/production-readiness.yml",
    "Packaging requires the protected readiness workflow.");
  assert(hex(env.GITHUB_SHA, 40) && hex(pr.head.sha, 40), "Packaging requires exact source commits.");
}
export function verifyReviewedRepository(root, text, { env, event, now = new Date() }) {
  root = realpathSync(root);
  validatePackageManifest(text, now);
  validatePackageContext(env, event);
  return verifyPackageSource(root, text, { checkoutCommit: env.GITHUB_SHA, prHead: event.pull_request.head.sha, now });
}
// Source/archive verification is independently usable for local review. It grants
// no CI eligibility; the builder can only enter through verifyReviewedRepository.
export function verifyPackageSource(root, text, { checkoutCommit, prHead, now = new Date() }) {
  root = realpathSync(root);
  const manifest = validatePackageManifest(text, now);
  assert(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "Packaging checkout is not clean and fully tracked.");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  assert(head === checkoutCommit, "Packaging checkout does not match the event commit.");
  const parents = git(root, ["rev-list", "--parents", "-n", "1", prHead]).trim().split(" ");
  assert(parents.length === 2 && parents[1] === manifest.reviewedCommit,
    "Packaging requires a binding-only successor to the reviewed commit.");
  for (const target of [prHead, head]) {
    const changed = git(root, ["diff", "--name-only", "-z", manifest.reviewedCommit, target]).split("\0").filter(Boolean);
    assert(changed.length === 1 && changed[0] === PACKAGE_REVIEW_FILE, "Unreviewed source or merge-tree drift.");
  }
  git(root, ["merge-base", "--is-ancestor", prHead, head]);
  const snapshot = fingerprintPackageSource(root);
  assert(snapshot.sha256 === manifest.sourceSha256 && snapshot.fileCount === manifest.sourceFileCount,
    "Packaging source inventory drift.");
  const appLock = sha(readFileSync(join(root, "package-lock.json")));
  const toolLock = sha(readFileSync(join(root, ".github/toolchains/vercel65/package-lock.json")));
  assert(appLock === manifest.appLockSha256 && toolLock === manifest.toolLockSha256, "Packaging dependency lock drift.");
  assert(readFileSync(join(root, PACKAGE_REVIEW_FILE), "utf8") === text, "Packaging manifest drift.");
  return { manifest, snapshot, head, manifestSha256: sha(Buffer.from(text)), appLock, toolLock };
}
export function verifyArchivedSource(root, review) {
  root = realpathSync(root);
  const names = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const info = lstatSync(file);
      assert(!info.isSymbolicLink(), "Archived source contains a symbolic link.");
      if (info.isDirectory()) walk(file);
      else { assert(info.isFile(), "Archived source contains an unsupported entry."); names.push(relative(root, file).split(sep).join("/")); }
    }
  }
  walk(root);
  const expected = [...review.snapshot.entries.map((entry) => entry.path), PACKAGE_REVIEW_FILE].sort();
  assert(JSON.stringify(names.sort()) === JSON.stringify(expected), "Archived source inventory differs from reviewed source.");
  for (const entry of review.snapshot.entries) assert(regular(root, entry.path, entry.mode).sha256 === entry.sha256,
    "Archived source bytes differ from review.");
  assert(sha(readFileSync(join(root, PACKAGE_REVIEW_FILE))) === review.manifestSha256, "Archived review manifest drift.");
}
export function validatePackageDestination(root, directory, runnerTemp) {
  assert(typeof directory === "string" && directory.length > 0 && typeof runnerTemp === "string", "Missing isolated package destination.");
  root = realpathSync(root);
  const target = resolve(directory);
  const temporary = realpathSync(runnerTemp);
  assert(inside(temporary, target) && target !== temporary && !inside(root, target) && !inside(target, root),
    "Packaging destination must be isolated inside runner temp.");
  assert(resolve(dirname(target)) === realpathSync(dirname(target)), "Packaging destination parent is an alias.");
  try { lstatSync(target); } catch (error) { if (error.code === "ENOENT") return target; throw error; }
  throw new Error("Packaging destination already exists; refusing reuse.");
}
export function verifyLocalPackageDependencies(root, lock) {
  root = realpathSync(root);
  const records = [];
  const targets = new Set(Object.values(lock.packages).filter((entry) => entry.link).map((entry) => entry.resolved));
  for (const target of targets) {
    safePath(target);
    const directory = resolve(root, target);
    assert(inside(root, directory) && realpathSync(directory) === directory, "Local package source escapes archive.");
    const local = lock.packages[target];
    assert(local && typeof local.name === "string", "Missing locked local package.");
    const require = createRequire(join(directory, "package.json"));
    for (const dependency of Object.keys(local.dependencies ?? {})) {
      const entry = realpathSync(require.resolve(dependency));
      assert(inside(root, entry), "Relocated dependency resolves outside candidate.");
      let parent = dirname(entry);
      let found;
      while (inside(root, parent)) {
        try {
          const data = JSON.parse(readFileSync(join(parent, "package.json"), "utf8"));
          if (data.name === dependency) { found = { parent, data }; break; }
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
        if (parent === root) break;
        parent = dirname(parent);
      }
      assert(found, "Relocated dependency metadata missing.");
      const lockPath = relative(root, found.parent).split(sep).join("/");
      let cursor = directory;
      let expectedPath;
      while (inside(root, cursor)) {
        const key = relative(root, join(cursor, "node_modules", dependency)).split(sep).join("/");
        if (lock.packages[key]) {
          expectedPath = lock.packages[key].link ? safePath(lock.packages[key].resolved) : key;
          break;
        }
        if (cursor === root) break;
        cursor = dirname(cursor);
      }
      assert(expectedPath === lockPath && lock.packages[expectedPath]?.version === found.data.version,
        "Relocated dependency path/version differs from frozen lock.");
      records.push({ package: local.name, dependency, version: found.data.version, lockPath });
    }
  }
  return records;
}
