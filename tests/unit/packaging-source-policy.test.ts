import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PACKAGE_REVIEW_FILE, PACKAGE_REVIEW_EXPIRY, fingerprintPackageSource, validatePackageManifest,
  verifyReviewedRepository, verifyPackageSource, validatePackageContext, validateHostedPackageContext,
  verifyArchivedSource, validatePackageDestination, verifyLocalPackageDependencies,
} from "../../scripts/lib/packaging-source-policy.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = new Date("2026-10-23T12:00:00.000Z");
const gitEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Synthetic Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Synthetic Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function command(root: string, args: string[]) {
  const child = spawnSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr);
  return child.stdout.trim();
}
function temporary() { const root = mkdtempSync(join(tmpdir(), "package-review-")); roots.push(root); return root; }
function write(root: string, path: string, body = "synthetic\n") {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
}
function context(head: string) {
  const repo = { id: 1317195955, full_name: "owner-ci/repbook-workout-tracker", private: false, owner: { id: 132015621 } };
  return {
    env: { CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux",
      GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/140/merge", GITHUB_REPOSITORY: repo.full_name,
      GITHUB_REPOSITORY_OWNER: "owner-ci", GITHUB_ACTOR: "owner-ci", GITHUB_TRIGGERING_ACTOR: "owner-ci",
      GITHUB_REPOSITORY_OWNER_ID: "132015621", GITHUB_HEAD_REF: "codex/one-next-move-public-review",
      GITHUB_BASE_REF: "main", GITHUB_WORKFLOW_REF: repo.full_name + "/.github/workflows/production-readiness.yml@refs/pull/140/merge",
      GITHUB_SHA: head },
    event: { number: 140, repository: repo, sender: { id: 132015621 }, pull_request: {
      user: { id: 132015621 }, author_association: "OWNER",
      head: { sha: head, ref: "codex/one-next-move-public-review", repo: structuredClone(repo) },
      base: { ref: "main", repo: structuredClone(repo) },
    } }, now,
  };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const syntheticIdentity = {
  repositorySha256: hash("owner-ci/repbook-workout-tracker"), ownerLoginSha256: hash("owner-ci"),
  repositoryId: 1317195955, ownerId: 132015621,
};
function verifyFixture(root: string, text: string, c: ReturnType<typeof context>) {
  validateHostedPackageContext(c.env, c.event, syntheticIdentity);
  return verifyPackageSource(root, text, { checkoutCommit: c.env.GITHUB_SHA, prHead: c.event.pull_request.head.sha, now: c.now });
}
function fixture(change?: (manifest: Record<string, unknown>, root: string) => void, prepareSource?: (root: string) => void) {
  const root = temporary();
  command(root, ["init", "-b", "candidate"]);
  for (const name of ["src/app.ts", "tools/lint/config.js", "vendor/style.css", "scripts/build.mjs", ".github/workflows/test.yml"]) write(root, name);
  write(root, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  write(root, ".github/toolchains/vercel65/package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  write(root, PACKAGE_REVIEW_FILE, "{}\n");
  prepareSource?.(root);
  command(root, ["add", "."]); command(root, ["commit", "-m", "Synthetic reviewed source"]);
  const reviewed = command(root, ["rev-parse", "HEAD"]);
  const snapshot = fingerprintPackageSource(root);
  const find = (name: string) => snapshot.entries.find((entry: { path: string }) => entry.path === name)!.sha256;
  const manifest: Record<string, unknown> = {
    schemaVersion: 1, purpose: "local-deployment-package-review", status: "reviewed", reviewedCommit: reviewed,
    sourceSha256: snapshot.sha256, sourceFileCount: snapshot.fileCount,
    appLockSha256: find("package-lock.json"), toolLockSha256: find(".github/toolchains/vercel65/package-lock.json"),
    expiresAt: PACKAGE_REVIEW_EXPIRY, nodeVersion: "24.18.0", vercelVersion: "65.0.0",
  };
  change?.(manifest, root);
  const text = JSON.stringify(manifest, null, 2) + "\n"; write(root, PACKAGE_REVIEW_FILE, text);
  command(root, ["add", "."]); command(root, ["commit", "-m", "Synthetic binding only"]);
  const head = command(root, ["rev-parse", "HEAD"]);
  return { root, text, manifest, reviewed, head, context: context(head) };
}
describe("independent packaging review", () => {
  it("accepts exactly a clean binding-only successor and inventories all source families", () => {
    const f = fixture(); const verified = verifyFixture(f.root, f.text, f.context);
    expect(verified.head).toBe(f.head);
    for (const name of ["src/app.ts", "tools/lint/config.js", "vendor/style.css", "scripts/build.mjs", ".github/workflows/test.yml"]) {
      expect(verified.snapshot.entries.some((entry: { path: string }) => entry.path === name)).toBe(true);
    }
    expect(verified.snapshot.entries.some((entry: { path: string }) => entry.path === PACKAGE_REVIEW_FILE)).toBe(false);
  });
  it.each(["sourceSha256", "appLockSha256", "toolLockSha256"])("rejects changed %s", (field) => {
    const f = fixture((m) => { m[field] = "f".repeat(64); });
    expect(() => verifyFixture(f.root, f.text, f.context)).toThrow(/drift/);
  });
  it("rejects count drift, extended expiry, other toolchains, pending review and unknown fields", () => {
    for (const edit of [
      { sourceFileCount: 999 }, { expiresAt: "2027-10-28T12:30:00.000Z" }, { nodeVersion: "26.0.0" },
      { vercelVersion: "66.0.0" }, { status: "pending-review" }, { ignoreAudit: true },
    ]) {
      const f = fixture((m) => Object.assign(m, edit));
      expect(() => verifyFixture(f.root, f.text, f.context)).toThrow();
    }
  });
  it("rejects exact expiry and noncanonical or duplicate-key manifests", () => {
    const f = fixture();
    expect(() => validatePackageManifest(f.text, new Date(PACKAGE_REVIEW_EXPIRY))).toThrow(/expired/);
    expect(() => validatePackageManifest(" " + f.text, now)).toThrow(/canonical/);
    expect(() => validatePackageManifest(f.text.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,'), now)).toThrow(/canonical/);
  });
  it.each(["src/app.ts", "tools/lint/config.js", "vendor/style.css", "scripts/build.mjs", ".github/workflows/test.yml"])(
    "rejects unreviewed committed source %s", (name) => {
      const f = fixture((_m, root) => write(root, name, "unreviewed\n"));
      expect(() => verifyFixture(f.root, f.text, f.context)).toThrow(/source/);
    },
  );
  it("rejects dirty, staged, untracked and executable-mode changes", () => {
    for (const edit of ["dirty", "staged", "untracked", "mode"]) {
      const f = fixture();
      if (edit === "untracked") write(f.root, "unexpected.txt");
      else if (edit === "mode") chmodSync(join(f.root, "src/app.ts"), 0o755);
      else { write(f.root, "src/app.ts", "changed"); if (edit === "staged") command(f.root, ["add", "."]); }
      expect(() => verifyFixture(f.root, f.text, f.context)).toThrow(/clean|mode/);
    }
  });
  it("accepts frozen toolchain installation without ignoring unreviewed toolchain source", () => {
    const f = fixture(undefined, (root) => {
      for (const name of [".gitignore", ".github/toolchains/vercel65/.gitignore"]) {
        if (existsSync(name)) write(root, name, readFileSync(name, "utf8"));
      }
    });
    write(f.root, ".github/toolchains/vercel65/node_modules/vercel/package.json", '{"name":"vercel","version":"65.0.0"}');
    expect(() => verifyFixture(f.root, f.text, f.context)).not.toThrow();
    write(f.root, ".github/toolchains/vercel65/unreviewed-source.js", "unreviewed source\n");
    expect(() => verifyFixture(f.root, f.text, f.context)).toThrow(/clean/);
  });
  it("rejects symlink source and a non-binding successor", () => {
    const f = fixture(); symlinkSync("app.ts", join(f.root, "src/link.ts")); command(f.root, ["add", "."]);
    expect(() => fingerprintPackageSource(f.root)).toThrow(/Unsupported/);
    const other = fixture(); command(other.root, ["commit", "--allow-empty", "-m", "Not a binding"]);
    const head = command(other.root, ["rev-parse", "HEAD"]);
    expect(() => verifyFixture(other.root, other.text, context(head))).toThrow(/binding-only/);
  });
  it("accepts an unchanged merge tree and rejects base-branch source drift", () => {
    for (const drift of [false, true]) {
      const f = fixture();
      command(f.root, ["checkout", "-b", "base", f.reviewed]);
      if (drift) { write(f.root, "vendor/style.css", "base drift"); command(f.root, ["add", "."]); }
      command(f.root, ["commit", "--allow-empty", "-m", "Synthetic base"]);
      command(f.root, ["merge", "--no-ff", "candidate", "-m", "Synthetic PR merge"]);
      const c = context(f.head); c.env.GITHUB_SHA = command(f.root, ["rev-parse", "HEAD"]);
      if (drift) expect(() => verifyFixture(f.root, f.text, c)).toThrow(/merge-tree drift/);
      else expect(verifyFixture(f.root, f.text, c).head).toBe(c.env.GITHUB_SHA);
    }
  });
  it("keeps the production identity pinned and rejects synthetic fixture identity", () => {
    const f = fixture();
    expect(() => validatePackageContext(f.context.env, f.context.event)).toThrow(/reviewed owner/);
    expect(() => verifyReviewedRepository(f.root, f.text, f.context)).toThrow(/reviewed owner/);
    const builder = readFileSync("scripts/build-candidate-package.mjs", "utf8");
    expect(builder).toContain("verifyReviewedRepository(root, text, context)");
    expect(builder).not.toContain("verifyPackageSource(");
    expect(builder).not.toContain("validateHostedPackageContext(");
  });
  it("rejects untrusted event, owner, fork, branch, workflow, platform and checkout contexts", () => {
    const f = fixture();
    for (const edit of [
      (c: ReturnType<typeof context>) => { c.env.GITHUB_EVENT_NAME = "workflow_dispatch"; },
      (c: ReturnType<typeof context>) => { c.env.GITHUB_ACTOR = "untrusted"; },
      (c: ReturnType<typeof context>) => { c.env.GITHUB_TRIGGERING_ACTOR = "untrusted"; },
      (c: ReturnType<typeof context>) => { c.event.pull_request.head.repo.id = 2; },
      (c: ReturnType<typeof context>) => { c.event.pull_request.head.repo.private = true; },
      (c: ReturnType<typeof context>) => { c.event.sender.id = 2; },
      (c: ReturnType<typeof context>) => { c.env.GITHUB_HEAD_REF = "other"; },
      (c: ReturnType<typeof context>) => { c.env.GITHUB_WORKFLOW_REF = "other"; },
      (c: ReturnType<typeof context>) => { c.env.RUNNER_OS = "Darwin"; },
      (c: ReturnType<typeof context>) => { c.env.RUNNER_ENVIRONMENT = "self-hosted"; },
      (c: ReturnType<typeof context>) => { c.env.GITHUB_SHA = "a".repeat(40); },
    ]) {
      const c = context(f.head); edit(c);
      expect(() => verifyFixture(f.root, f.text, c)).toThrow();
    }
  });
  it("verifies actual extracted bytes, modes, manifest and complete archive contents", () => {
    const f = fixture(); const review = verifyFixture(f.root, f.text, f.context);
    for (const edit of ["none", "bytes", "extra", "missing", "mode", "symlink", "manifest"]) {
      const destination = temporary();
      const archive = spawnSync("git", ["archive", f.head], { cwd: f.root });
      expect(archive.status).toBe(0);
      expect(spawnSync("tar", ["-xf", "-", "-C", destination], { input: archive.stdout }).status).toBe(0);
      if (edit === "bytes") write(destination, "vendor/style.css", "different");
      if (edit === "extra") write(destination, "unexpected");
      if (edit === "missing") rmSync(join(destination, "src/app.ts"));
      if (edit === "mode") chmodSync(join(destination, "src/app.ts"), 0o755);
      if (edit === "symlink") symlinkSync("src/app.ts", join(destination, "alias"));
      if (edit === "manifest") write(destination, PACKAGE_REVIEW_FILE, "{}");
      if (edit === "none") expect(() => verifyArchivedSource(destination, review)).not.toThrow();
      else expect(() => verifyArchivedSource(destination, review)).toThrow();
    }
  });
  it("requires a fresh nonalias destination isolated from source inside runner temp", () => {
    const f = fixture(); const runner = temporary(); const target = join(runner, "fresh");
    expect(validatePackageDestination(f.root, target, runner)).toBe(target);
    mkdirSync(target); expect(() => validatePackageDestination(f.root, target, runner)).toThrow(/exists/);
    expect(() => validatePackageDestination(f.root, f.root, runner)).toThrow(/isolated/);
    expect(() => validatePackageDestination(f.root, join(f.root, "inside"), f.root)).toThrow(/isolated/);
    expect(() => validatePackageDestination(f.root, runner, runner)).toThrow(/isolated/);
    mkdirSync(join(runner, "actual")); symlinkSync("actual", join(runner, "alias"));
    expect(() => validatePackageDestination(f.root, join(runner, "alias", "fresh"), runner)).toThrow(/alias/);
  });
  it("keeps the complete actual local-file dependency resolutions", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const records = verifyLocalPackageDependencies(process.cwd(), lock);
    expect(records.find((record: { dependency: string }) => record.dependency === "globals"))
      .toMatchObject({ version: "16.4.0", lockPath: "tools/next-eslint/node_modules/globals" });
  });
  it("rejects omitted nested file-package dependencies instead of falling back to another locked version", () => {
    const root = temporary();
    write(root, "tools/local/package.json", '{"name":"local","dependencies":{"globals":"16.4.0"}}');
    for (const [path, version] of [["node_modules/globals", "14.0.0"], ["tools/local/node_modules/globals", "16.4.0"]]) {
      write(root, path + "/package.json", JSON.stringify({ name: "globals", version, main: "index.js" }));
      write(root, path + "/index.js", "module.exports = {};");
    }
    const lock = { packages: {
      "node_modules/local": { link: true, resolved: "tools/local" }, "tools/local": { name: "local", dependencies: { globals: "16.4.0" } },
      "node_modules/globals": { version: "14.0.0" }, "tools/local/node_modules/globals": { version: "16.4.0" },
    } };
    expect(verifyLocalPackageDependencies(root, lock)[0].version).toBe("16.4.0");
    const omitted = temporary();
    write(omitted, "tools/local/package.json", '{"name":"local","dependencies":{"globals":"16.4.0"}}');
    write(omitted, "node_modules/globals/package.json", '{"name":"globals","version":"14.0.0","main":"index.js"}');
    write(omitted, "node_modules/globals/index.js", "module.exports = {};");
    expect(() => verifyLocalPackageDependencies(omitted, lock)).toThrow(/path\/version/);
  });
  it("retains strict audits, frozen installs, sanitized builds and inventory failure propagation", () => {
    const builder = readFileSync("scripts/build-candidate-package.mjs", "utf8");
    expect(builder).not.toContain("candidate-dependency-audit-exception.json");
    expect(builder).not.toContain("--candidate-review");
    expect(builder).toContain('"ci", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"');
    expect(builder).toContain('NPM_CONFIG_OFFLINE: "false", REPBOOK_AUDIT_REPORT_DIR');
    expect(builder.indexOf("verifyArchivedSource(candidate, review)")).toBeLessThan(builder.indexOf('["ci",'));
    expect(builder).toContain("throw new Error(\"Missing required function inventory\")");
    expect(builder).not.toContain("...process.env");
    expect(builder).not.toContain('join(root, "node_modules")');
  });
});
