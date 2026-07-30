import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const severityRank = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

const policy = JSON.parse(
  await readFile("./docs/dependency-audit-exceptions.json", "utf8")
);
const today = new Date().toISOString().slice(0, 10);
const exceptions = policy.exceptions.map((entry) => {
  if (entry.expiresOn < today) {
    throw new Error(
      `Dependency-audit exception ${entry.advisory} expired on ${entry.expiresOn}.`
    );
  }
  return entry;
});

const audit = spawnSync(
  "npm",
  ["audit", "--omit=dev", "--audit-level=moderate", "--json"],
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);
if (audit.error) throw audit.error;
if (!audit.stdout.trim()) {
  throw new Error(audit.stderr.trim() || "npm audit returned no JSON output.");
}

const report = JSON.parse(audit.stdout);
const unexpected = [];
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  const objectAdvisories = vulnerability.via.filter(
    (item) => typeof item === "object" && item !== null
  );
  const packageLinks = vulnerability.via.filter(
    (item) => typeof item === "string"
  );
  const exception = exceptions.find((candidate) => {
    const directMatch = objectAdvisories.some(
      (advisory) => advisory.url === candidate.advisory
    );
    const inheritedMatch = packageLinks.some((name) =>
      candidate.packages.includes(name)
    );
    return (
      candidate.packages.includes(vulnerability.name) &&
      (directMatch || inheritedMatch) &&
      (severityRank.get(vulnerability.severity) ?? Infinity) <=
        (severityRank.get(candidate.maximumSeverity) ?? -1)
    );
  });
  if (!exception) unexpected.push(vulnerability);
}

if (unexpected.length > 0) {
  console.error(
    JSON.stringify(
      unexpected.map((item) => ({
        name: item.name,
        severity: item.severity,
        via: item.via,
        range: item.range,
      })),
      null,
      2
    )
  );
  process.exit(1);
}

const totals = report.metadata?.vulnerabilities ?? {};
console.log(
  JSON.stringify({
    status: "passed",
    vulnerabilities: totals,
    acceptedExceptions: exceptions.map((entry) => ({
      advisory: entry.advisory,
      expiresOn: entry.expiresOn,
    })),
  })
);
