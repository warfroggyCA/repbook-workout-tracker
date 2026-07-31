import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  evaluateFullTreeAudit,
  summarizeVulnerability,
  validateAuditPolicy,
} from "./lib/dependency-audit-policy.mjs";

const policy = JSON.parse(
  await readFile("./docs/dependency-audit-exceptions.json", "utf8")
);
const lockfile = JSON.parse(await readFile("./package-lock.json", "utf8"));
const today = new Date().toISOString().slice(0, 10);
const exceptions = validateAuditPolicy(policy, lockfile.packages, today);

function runAudit(args) {
  const audit = spawnSync("npm", ["audit", ...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;
  if (audit.status !== 0 && audit.status !== 1) {
    throw new Error(audit.stderr.trim() || `npm audit exited with status ${audit.status}.`);
  }
  if (!audit.stdout.trim()) {
    throw new Error(audit.stderr.trim() || "npm audit returned no JSON output.");
  }
  return JSON.parse(audit.stdout);
}

const productionReport = runAudit(["--omit=dev", "--audit-level=moderate"]);
const productionVulnerabilities = Object.values(productionReport.vulnerabilities ?? {});
if (productionVulnerabilities.length > 0) {
  console.error(JSON.stringify(productionVulnerabilities.map(summarizeVulnerability), null, 2));
  process.exit(1);
}

const fullTreeReport = runAudit(["--audit-level=moderate"]);
const { unexpected, staleExceptions } = evaluateFullTreeAudit(fullTreeReport, exceptions);
if (unexpected.length > 0 || staleExceptions.length > 0) {
  console.error(
    JSON.stringify(
      {
        unexpected: unexpected.map(summarizeVulnerability),
        staleExceptions: staleExceptions.map((entry) => entry.advisory),
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      productionVulnerabilities: productionReport.metadata?.vulnerabilities ?? {},
      fullTreeVulnerabilities: fullTreeReport.metadata?.vulnerabilities ?? {},
      acceptedDevelopmentExceptions: exceptions.map((entry) => ({
        advisory: entry.advisory,
        expiresOn: entry.expiresOn,
      })),
    },
    null,
    2
  )
);
