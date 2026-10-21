import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const REVIEWED_BASELINE = "f5331782c9bb9baad92a1ea368c130d4eab2f910";
export const CANDIDATE_EXPIRY = "2026-10-28T12:30:00.000Z";
export const REVIEWED_LOCK_SHA256 = "341287458497d1b42e034e9c1752a4ff0a645ef3710ba03954f36e8ba731eb60";
export const REVIEWED_SOURCE_SHA256 = "21f1d5c606dcc37a8614dd8c21018abaf6518ccd354ac699b245dcdf3a018253";
export const REVIEWED_SOURCE_PATHS = Object.freeze([
  "src", "public", "package.json", "package-lock.json", "next.config.ts",
  "postcss.config.mjs", "tsconfig.json", "components.json", "eslint.config.mjs",
  "drizzle.config.ts",
]);
const APPROVED_POLICY_SHA256 = "5c6069369828d66cf378bff2e5932b47a96ddfd9f41038cebf3ecdcf8a03eb21";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const advisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (items) => [...items].sort();

export function fingerprintReviewedSource(root, paths = REVIEWED_SOURCE_PATHS) {
  assert(equal(paths, REVIEWED_SOURCE_PATHS), "Candidate source-path scope changed.");
  const entries = [];
  function visit(file) {
    const info = lstatSync(file);
    assert(!info.isSymbolicLink(), "Candidate source contains an unreviewed symbolic link.");
    if (info.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(resolve(file, name));
    } else {
      assert(info.isFile(), "Candidate source contains an unsupported file type.");
      const name = relative(root, file).split("\\").join("/");
      entries.push([name, createHash("sha256").update(readFileSync(file)).digest("hex")]);
    }
  }
  for (const path of paths) visit(resolve(root, path));
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const hash = createHash("sha256");
  for (const [name, digest] of entries) hash.update(name + "\0" + digest + "\n");
  return { sha256: hash.digest("hex"), fileCount: entries.length };
}

export function validateCandidateContext(policy, { env, event }) {
  assert(env.CI === "true" && env.GITHUB_ACTIONS === "true"
    && env.RUNNER_ENVIRONMENT === "github-hosted", "Candidate exception requires trusted hosted CI.");
  assert(env.GITHUB_EVENT_NAME === "pull_request", "Candidate exception is unavailable to production, push or manual runs.");
  const pr = event?.pull_request;
  assert(event?.repository?.private === false && pr?.head?.repo?.private === false
    && pr?.base?.repo?.private === false, "Candidate exception requires the reviewed public repository.");
  assert(env.GITHUB_ACTOR === env.GITHUB_REPOSITORY_OWNER
    && env.GITHUB_TRIGGERING_ACTOR === env.GITHUB_REPOSITORY_OWNER
    && String(env.GITHUB_REPOSITORY_OWNER_ID) === String(policy.ownerId)
    && event?.repository?.owner?.id === policy.ownerId
    && event?.sender?.id === policy.ownerId && pr?.user?.id === policy.ownerId
    && pr?.author_association === "OWNER", "Candidate exception requires the trusted owner.");
  assert(event.repository.id === policy.repositoryId && pr.head.repo.id === policy.repositoryId
    && pr.base.repo.id === policy.repositoryId, "Candidate exception rejects repository identity drift.");
  assert(env.GITHUB_REPOSITORY === event.repository.full_name
    && pr?.head?.repo?.full_name === env.GITHUB_REPOSITORY
    && pr?.base?.repo?.full_name === env.GITHUB_REPOSITORY
    && pr.head.repo.id === event.repository.id, "Candidate exception rejects fork or repository drift.");
  assert(pr?.head?.ref === policy.headRef && env.GITHUB_HEAD_REF === policy.headRef
    && pr?.base?.ref === policy.baseRef && env.GITHUB_BASE_REF === policy.baseRef,
    "Candidate exception rejects branch drift.");
  assert(Number.isInteger(event.number) && event.number > 0
    && env.GITHUB_REF === `refs/pull/${event.number}/merge`,
    "Candidate exception requires the reviewed pull-request merge context.");
  assert(env.GITHUB_WORKFLOW_REF?.split("@")[0]
    === `${env.GITHUB_REPOSITORY}/.github/workflows/production-readiness.yml`,
    "Candidate exception requires the protected readiness workflow.");
}

export function validateCandidateException(policy, {
  lockfile, lockfileSha256, source, fullTreeReport, context, now = new Date(),
}) {
  assert(createHash("sha256").update(JSON.stringify(canonical(policy))).digest("hex")
    === APPROVED_POLICY_SHA256, "Candidate exception policy changed; a new review is required.");
  assert(policy.schemaVersion === 1 && policy.scope === "owner-candidate-pr-ci"
    && policy.advisory === advisory, "Unexpected candidate exception.");
  assert(policy.baselineCommit === REVIEWED_BASELINE
    && policy.lockfileSha256 === REVIEWED_LOCK_SHA256
    && policy.sourceSha256 === REVIEWED_SOURCE_SHA256
    && equal(policy.sourcePaths, REVIEWED_SOURCE_PATHS), "Candidate review baseline changed.");
  assert(policy.expiresAt === CANDIDATE_EXPIRY, "Candidate exception expiry changed; renewal requires a new review.");
  const instant = now instanceof Date ? now.getTime() : NaN;
  assert(Number.isFinite(instant) && instant < Date.parse(CANDIDATE_EXPIRY),
    `Candidate exception expired at ${CANDIDATE_EXPIRY}.`);
  validateCandidateContext(policy, context);
  assert(lockfileSha256 === REVIEWED_LOCK_SHA256, "Candidate dependency lockfile drift.");
  assert(source.sha256 === REVIEWED_SOURCE_SHA256 && source.fileCount === policy.sourceFileCount,
    "Candidate application source drift.");
  assert(lockfile?.lockfileVersion === 3, "Unexpected candidate lockfile format.");
  for (const [node, version] of Object.entries(policy.reviewedNodes)) {
    const pkg = lockfile.packages?.[node];
    assert(pkg?.version === version && pkg.dev === true,
      `Candidate dependency/version/development scope drift at ${node}.`);
  }
  assert(policy.reviewedNodes["node_modules/braces"] === "3.0.3", "Unreviewed braces version.");
  for (const [name, expected] of Object.entries(policy.expectedFindings)) {
    const actual = fullTreeReport.vulnerabilities?.[name];
    assert(actual?.name === name && actual.severity === expected.severity,
      `Candidate advisory or severity drift for ${name}.`);
    assert(Array.isArray(actual.nodes) && equal(sorted(actual.nodes), expected.nodes),
      `Candidate dependency-path drift for ${name}.`);
    const causes = actual.via?.map((cause) => typeof cause === "string" ? cause : cause?.url);
    assert(Array.isArray(causes) && equal(sorted(causes), expected.via),
      `Candidate advisory graph drift for ${name}.`);
  }
  return {
    scope: "development", advisory, packages: Object.keys(policy.expectedFindings),
    maximumSeverity: "high", expiresOn: CANDIDATE_EXPIRY.slice(0, 10),
    reason: policy.reason, reviewedNodes: policy.reviewedNodes,
  };
}
