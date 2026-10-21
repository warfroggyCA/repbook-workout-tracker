import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateFullTreeAudit, summarizeVulnerability, validateAuditReport, validateAuditPolicy,
} from "./lib/dependency-audit-policy.mjs";
import {
  CANDIDATE_EXPIRY, fingerprintReviewedSource, validateCandidateException,
} from "./lib/candidate-dependency-audit-policy.mjs";

const candidate = process.argv.slice(2).includes("--candidate-review");
if (process.argv.slice(2).some((arg) => arg !== "--candidate-review")) {
  throw new Error("Unknown audit option.");
}
const directory = process.env.REPBOOK_AUDIT_REPORT_DIR;
if (directory) await mkdir(directory, { recursive: true });
async function preserve(name, value) {
  if (directory) await writeFile(resolve(directory, name), value, { mode: 0o600 });
}
const policy = JSON.parse(await readFile("./docs/dependency-audit-exceptions.json", "utf8"));
const lockText = await readFile("./package-lock.json", "utf8");
const lockfile = JSON.parse(lockText);
const today = new Date().toISOString().slice(0, 10);


// Always retain both exact reports, including unsuccessful and malformed responses.
const results = [];
for (const [name, args] of [
  ["production", ["--omit=dev", "--audit-level=moderate"]],
  ["full", ["--audit-level=moderate"]],
]) {
  const result = spawnSync("npm", ["audit", ...args, "--json"], {
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000,
  });
  await preserve(name + ".raw.json", result.stdout ?? "");
  await preserve(name + ".stderr.txt", result.stderr ?? "");
  console.log(`Raw ${name} npm audit report:`);
  console.log(result.stdout ?? "");
  results.push({ name, result });
}
await preserve("exit-metadata.json", JSON.stringify(results.map(({ name, result }) => ({
  name, status: result.status, signal: result.signal, error: result.error?.message ?? null,
})), null, 2) + "\n");

const exceptions = validateAuditPolicy(policy, lockfile.packages, today);
const reports = results.map(({ name, result }) => {
  if (result.error) throw result.error;
  if (result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`${name} npm audit failed with status ${result.status}.`);
  }
  if (!result.stdout?.trim()) throw new Error(`${name} npm audit returned no JSON output.`);
  return validateAuditReport(JSON.parse(result.stdout));
});
const [productionReport, fullTreeReport] = reports;
const productionVulnerabilities = Object.values(productionReport.vulnerabilities);
if (productionVulnerabilities.length > 0) {
  console.error(JSON.stringify(productionVulnerabilities.map(summarizeVulnerability), null, 2));
  process.exit(1);
}

if (candidate) {
  const candidatePolicy = JSON.parse(
    await readFile("./docs/candidate-dependency-audit-exception.json", "utf8"),
  );
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Candidate exception requires a GitHub event record.");
  const exception = validateCandidateException(candidatePolicy, {
    lockfile,
    lockfileSha256: createHash("sha256").update(lockText).digest("hex"),
    source: fingerprintReviewedSource(process.cwd(), candidatePolicy.sourcePaths),
    fullTreeReport,
    context: { env: process.env, event: JSON.parse(await readFile(eventPath, "utf8")) },
  });
  exceptions.push(exception);
  console.warn(`::warning title=Temporary candidate-only dependency exception::${exception.advisory} remains vulnerable; expires ${CANDIDATE_EXPIRY}. Production acceptance is unchanged.`);
}
const { unexpected, staleExceptions } = evaluateFullTreeAudit(fullTreeReport, exceptions);
if (unexpected.length > 0 || staleExceptions.length > 0) {
  console.error(JSON.stringify({
    unexpected: unexpected.map(summarizeVulnerability),
    staleExceptions: staleExceptions.map((entry) => entry.advisory),
  }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: "passed", candidateOnly: candidate,
  productionVulnerabilities: productionReport.metadata.vulnerabilities,
  fullTreeVulnerabilities: fullTreeReport.metadata.vulnerabilities,
  acceptedDevelopmentExceptions: exceptions.map((entry) => ({
    advisory: entry.advisory,
    expiresAt: entry.advisory.endsWith("GHSA-vfj7-8cjw-p6xm") ? CANDIDATE_EXPIRY : entry.expiresOn,
  })),
}, null, 2));
