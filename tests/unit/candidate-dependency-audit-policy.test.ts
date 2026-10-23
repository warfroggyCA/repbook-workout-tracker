import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (source: string) => unknown };
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_EXPIRY, REVIEWED_LOCK_SHA256, REVIEWED_SOURCE_SHA256,
  fingerprintReviewedSource, validateCandidateException,
} from "../../scripts/lib/candidate-dependency-audit-policy.mjs";
import { evaluateFullTreeAudit, validateAuditReport } from "../../scripts/lib/dependency-audit-policy.mjs";

const root = resolve(__dirname, "../..");
const policy = JSON.parse(readFileSync(join(root, "docs/candidate-dependency-audit-exception.json"), "utf8"));
const currentLockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
// Positive cases model the retired review; the actual current tree must fail it.
const lockfile: { lockfileVersion: number; packages: Record<string, { version: string; dev: boolean } | undefined> } = {
  lockfileVersion: 3,
  packages: Object.fromEntries(
    Object.entries(policy.reviewedNodes).map(([path, version]) => [
      path, { version: String(version), dev: true },
    ]),
  ),
};
const copy = <T,>(value: T): T => structuredClone(value);
const counts = (high = 0) => ({ info: 0, low: 0, moderate: 0, high, critical: 0, total: high });
function reviewedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(Object.entries(policy.expectedFindings).map(([name, raw]) => {
      const finding = raw as { severity: string; nodes: string[]; via: string[] };
      return [name, {
        name, severity: finding.severity, nodes: copy(finding.nodes), range: "*",
        via: finding.via.map((cause) => cause.startsWith("https:") ? { url: cause } : cause),
      }];
    })),
    metadata: { vulnerabilities: counts(8) },
  };
}
function context() {
  const repo = { full_name: "synthetic-owner/synthetic-repository", private: false, id: 1317195955, owner: { id: policy.ownerId } };
  return {
    env: {
      GITHUB_ACTOR: "synthetic-owner", GITHUB_TRIGGERING_ACTOR: "synthetic-owner",
      GITHUB_REPOSITORY_OWNER: "synthetic-owner", GITHUB_REPOSITORY_OWNER_ID: String(policy.ownerId),
      CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: repo.full_name,
      GITHUB_HEAD_REF: policy.headRef, GITHUB_BASE_REF: "main", GITHUB_REF: "refs/pull/7/merge",
      GITHUB_WORKFLOW_REF: repo.full_name + "/.github/workflows/production-readiness.yml@refs/pull/7/merge",
    },
    event: {
      number: 7, repository: repo, sender: { id: policy.ownerId },
      pull_request: { user: { id: policy.ownerId }, author_association: "OWNER", head: { repo: copy(repo), ref: policy.headRef }, base: { repo: copy(repo), ref: "main" } },
    },
  };
}
function input() {
  return {
    lockfile: copy(lockfile), lockfileSha256: REVIEWED_LOCK_SHA256,
    source: { sha256: REVIEWED_SOURCE_SHA256, fileCount: policy.sourceFileCount },
    fullTreeReport: reviewedReport(), context: context(),
    now: new Date("2026-10-28T12:29:59.999Z"),
  };
}
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("temporary owner-candidate audit exception", () => {
  it("accepts exactly the frozen review immediately before expiry and retains the high warning", () => {
    const report = reviewedReport();
    const entry = validateCandidateException(policy, input());
    expect(evaluateFullTreeAudit(report, [entry])).toEqual({ unexpected: [], staleExceptions: [] });
    expect(report.vulnerabilities.braces).toMatchObject({ severity: "high", nodes: ["node_modules/braces"] });
    expect(entry.advisory).toContain("GHSA-vfj7-8cjw-p6xm");
  });
  it.each([CANDIDATE_EXPIRY, "2026-10-28T12:30:00.001Z", "2026-10-29T00:00:00Z"])(
    "expires without a grace period at %s", (time) => {
      expect(() => validateCandidateException(policy, { ...input(), now: new Date(time) })).toThrow(/expired/);
    },
  );
  it("rejects an invalid clock and any policy renewal or scope edit", () => {
    expect(() => validateCandidateException(policy, { ...input(), now: new Date("invalid") })).toThrow(/expired/);
    for (const changed of [
      { ...policy, expiresAt: "2026-11-01T00:00:00.000Z" },
      { ...policy, scope: "production" },
      { ...policy, baselineCommit: "0".repeat(40) },
      { ...policy, reviewedNodes: { ...policy.reviewedNodes, "node_modules/other": "1.0.0" } },
    ]) expect(() => validateCandidateException(changed, input())).toThrow(/policy changed/);
  });
  it.each(["push", "workflow_dispatch", "pull_request_target"])("rejects the %s event", (event) => {
    const data = input(); data.context.env.GITHUB_EVENT_NAME = event;
    expect(() => validateCandidateException(policy, data)).toThrow(/unavailable/);
  });
  it("rejects local, self-hosted, private, non-owner, fork, branch and workflow drift", () => {
    const edits = [
      (x: ReturnType<typeof input>) => { x.context.env.GITHUB_ACTOR = "outsider"; },
      (x: ReturnType<typeof input>) => { x.context.env.GITHUB_TRIGGERING_ACTOR = "outsider"; },
      (x: ReturnType<typeof input>) => { x.context.event.sender.id = 1; },
      (x: ReturnType<typeof input>) => { x.context.event.pull_request.user.id = 1; },
      (x: ReturnType<typeof input>) => { x.context.event.pull_request.author_association = "CONTRIBUTOR"; },
      (x: ReturnType<typeof input>) => { x.context.event.repository.id = 2; },
      (x: ReturnType<typeof input>) => { x.context.env.GITHUB_ACTIONS = "false"; },
      (x: ReturnType<typeof input>) => { x.context.env.RUNNER_ENVIRONMENT = "self-hosted"; },
      (x: ReturnType<typeof input>) => { x.context.event.repository.private = true; },
      (x: ReturnType<typeof input>) => { x.context.event.pull_request.head.repo.full_name = "external/fork"; },
      (x: ReturnType<typeof input>) => { x.context.event.pull_request.head.repo.id = 99; },
      (x: ReturnType<typeof input>) => { x.context.event.pull_request.head.ref = "unreviewed"; },
      (x: ReturnType<typeof input>) => { x.context.env.GITHUB_REF = "refs/heads/main"; },
      (x: ReturnType<typeof input>) => { x.context.env.GITHUB_WORKFLOW_REF = "other/workflow.yml@main"; },
    ];
    for (const edit of edits) {
      const data = input(); edit(data);
      expect(() => validateCandidateException(policy, data)).toThrow();
    }
  });
  it("rejects the current tree instead of rebinding the retired review", () => {
    const actualSource = fingerprintReviewedSource(root);
    const actualLockSha256 = createHash("sha256")
      .update(readFileSync(join(root, "package-lock.json"))).digest("hex");
    expect(actualSource.sha256).not.toBe(REVIEWED_SOURCE_SHA256);
    expect(actualLockSha256).not.toBe(REVIEWED_LOCK_SHA256);
    expect(() => validateCandidateException(policy, {
      ...input(), source: actualSource,
      lockfile: currentLockfile, lockfileSha256: actualLockSha256,
    })).toThrow(/lockfile drift|source drift/);
    expect(() => validateCandidateException(policy, { ...input(), source: { sha256: "drift", fileCount: 934 } }))
      .toThrow(/source drift/);
    expect(() => validateCandidateException(policy, { ...input(), lockfileSha256: "drift" }))
      .toThrow(/lockfile drift/);
    expect(() => fingerprintReviewedSource(root, ["src"])).toThrow(/scope changed/);
  });
  it("rejects package version, missing-node and production-scope drift", () => {
    for (const value of [{ version: "3.0.4", dev: true }, { version: "3.0.3", dev: false }, undefined]) {
      const data = input();
      data.lockfile.packages["node_modules/braces"] = value;
      expect(() => validateCandidateException(policy, data)).toThrow(/scope drift/);
    }
  });
  it("rejects extra or missing paths, changed causes, severity escalation and stale findings", () => {
    const edits = [
      (r: ReturnType<typeof reviewedReport>) => { r.vulnerabilities.braces.nodes.push("node_modules/new/braces"); },
      (r: ReturnType<typeof reviewedReport>) => { r.vulnerabilities["fast-glob"].nodes.pop(); },
      (r: ReturnType<typeof reviewedReport>) => { r.vulnerabilities.braces.via.push({ url: "https://example.test/new" }); },
      (r: ReturnType<typeof reviewedReport>) => { r.vulnerabilities.braces.severity = "critical"; },
      (r: ReturnType<typeof reviewedReport>) => { delete r.vulnerabilities.braces; },
    ];
    for (const edit of edits) {
      const data = input(); edit(data.fullTreeReport);
      expect(() => validateCandidateException(policy, data)).toThrow(/drift/);
    }
  });
  it("keeps every unrelated finding fatal, even at low severity", () => {
    const data = input();
    const entry = validateCandidateException(policy, data);
    data.fullTreeReport.vulnerabilities.other = {
      name: "other", severity: "low", nodes: ["node_modules/other"], range: "*",
      via: [{ url: "https://github.com/advisories/GHSA-unreviewed" }],
    };
    expect(evaluateFullTreeAudit(data.fullTreeReport, [entry]).unexpected).toHaveLength(1);
    expect(evaluateFullTreeAudit(reviewedReport(), []).unexpected).toHaveLength(8);
  });
  it("rejects audit error JSON, inconsistent totals and malformed findings", () => {
    const r = reviewedReport();
    expect(() => validateAuditReport({ ...r, error: { code: "E503" } })).toThrow(/error/);
    expect(() => validateAuditReport({ ...r, metadata: { vulnerabilities: counts(0) } })).toThrow(/disagree/);
    r.vulnerabilities.braces.nodes = [];
    expect(() => validateAuditReport(r)).toThrow(/malformed/);
  });
});

describe("raw audit preservation and unchanged default gate", () => {
  function runFixture(status: number) {
    const dir = mkdtempSync(join(tmpdir(), "candidate-audit-"));
    roots.push(dir); const bin = join(dir, "bin"); mkdirSync(bin);
    const full = JSON.stringify(reviewedReport());
    const production = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: counts() } });
    const shim = join(bin, "npm");
    writeFileSync(shim, "#!/usr/bin/env node\nconst fs=require('node:fs'); const production=process.argv.includes('--omit=dev'); fs.appendFileSync(process.env.CALLS,production?'production\\n':'full\\n'); process.stdout.write(production?" + JSON.stringify(production) + ":" + JSON.stringify(full) + "); process.exit(" + status + ");\n");
    chmodSync(shim, 0o700);
    const reports = join(dir, "reports");
    const child = spawnSync(process.execPath, [join(root, "scripts/check-dependency-audit.mjs")], {
      cwd: root, encoding: "utf8",
      env: {
        NODE_ENV: "test", PATH: bin + ":" + process.env.PATH, CALLS: join(dir, "calls"),
        REPBOOK_AUDIT_REPORT_DIR: reports, TMPDIR: tmpdir(),
        NODE_COMPILE_CACHE: join(dir, "compile-cache"),
      },
    });
    return { dir, reports, child, full, production };
  }
  it("keeps complete exact reports and rejects the warning without the candidate opt-in", () => {
    const { dir, reports, child, full, production } = runFixture(1);
    expect(child.status).toBe(1);
    expect(readFileSync(join(reports, "full.raw.json"), "utf8")).toBe(full);
    expect(readFileSync(join(reports, "production.raw.json"), "utf8")).toBe(production);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("production\nfull\n");
    expect(child.stdout).toContain("GHSA-vfj7-8cjw-p6xm");
    expect(child.stderr).toContain("unexpected");
  });
  it("fails an audit command error while preserving both raw responses", () => {
    const { reports, child, full } = runFixture(2);
    expect(child.status).not.toBe(0);
    expect(readFileSync(join(reports, "full.raw.json"), "utf8")).toBe(full);
    expect(child.stderr).toContain("audit failed with status 2");
    expect(readFileSync(join(reports, "exit-metadata.json"), "utf8")).toContain('"status": 2');
  });
});

describe("deployment package inventory", () => {
  function packageFixture() {
    const dir = mkdtempSync(join(tmpdir(), "function-inventory-")); roots.push(dir);
    const bundle = join(dir, ".vercel/output/functions/test.func");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "launcher.cjs"), "module.exports = {};");
    writeFileSync(join(bundle, ".vc-config.json"), JSON.stringify({
      runtime: "nodejs24.x", architecture: "arm64", handler: "launcher.cjs", filePathMap: {},
    }));
    return { dir, bundle };
  }
  function inspect(dir: string) {
    return spawnSync("python3", ["-B", join(root, "scripts/inspect-candidate-functions.py"), dir, join(dir, "reports")], {
      encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: tmpdir() },
    });
  }
  it("checks physical output and mapped directory contents", () => {
    const { dir, bundle } = packageFixture();
    expect(inspect(dir).status).toBe(0);
    mkdirSync(join(dir, "node_modules/braces"), { recursive: true });
    writeFileSync(join(dir, "node_modules/braces/index.js"), "module.exports = {};");
    writeFileSync(join(bundle, ".vc-config.json"), JSON.stringify({
      runtime: "nodejs24.x", handler: "launcher.cjs",
      filePathMap: { "node_modules/braces": "node_modules/braces" },
    }));
    expect(inspect(dir).status).toBe(1);
    expect(readFileSync(join(dir, "reports/function-inventory.json"), "utf8")).toContain("Affected dependency path");
  });
  it("fails missing entry points, escaping map sources and unexpected runtimes", () => {
    for (const edit of [
      { runtime: "nodejs22.x", handler: "launcher.cjs" },
      { runtime: "nodejs24.x", handler: "absent.cjs" },
      { runtime: "nodejs24.x", handler: "launcher.cjs", filePathMap: { outside: "../outside.js" } },
    ]) {
      const { dir, bundle } = packageFixture();
      writeFileSync(join(bundle, ".vc-config.json"), JSON.stringify(edit));
      expect(inspect(dir).status).toBe(1);
    }
  });
});


describe("candidate workflow trigger eligibility", () => {
  it("keeps PR triggers explicit, manual acceptance unavailable and production protected", () => {
    const workflow = yaml.load(readFileSync(join(root, ".github/workflows/production-readiness.yml"), "utf8")) as {
      on: { pull_request: { types: string[] }; push: { branches: string[] }; workflow_dispatch: unknown };
      permissions: Record<string, string>;
      jobs: Record<string, { if?: string; needs?: string[]; env?: Record<string, string>; steps: { run?: string; env?: Record<string, string> }[] }>;
    };
    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(JSON.stringify(job.env ?? {})).not.toContain("${{ runner.");
    }
    expect(workflow.jobs["candidate-package"].steps.find((step) => step.run === "node scripts/build-candidate-package.mjs")?.env)
      .toEqual({ REPBOOK_PACKAGE_DIR: "${{ runner.temp }}/candidate-package" });
    expect(workflow.jobs["candidate-package"].if).toContain("github.event_name == 'pull_request'");
    expect(workflow.jobs.verify.needs).toEqual(["postgres-integration", "core", "browser", "candidate-package"]);
  });
});
