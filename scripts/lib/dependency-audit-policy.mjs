const severityRank = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAuditReport(report) {
  assert(
    isRecord(report) && report.auditReportVersion === 2,
    "npm audit did not return a version 2 audit report."
  );
  assert(
    isRecord(report.vulnerabilities),
    "npm audit report is missing its vulnerabilities inventory."
  );
  assert(
    isRecord(report.metadata) && isRecord(report.metadata.vulnerabilities),
    "npm audit report is missing its vulnerability totals."
  );

  const counts = report.metadata.vulnerabilities;
  for (const severity of [...severityRank.keys(), "total"]) {
    assert(
      Number.isInteger(counts[severity]) && counts[severity] >= 0,
      `npm audit report has an invalid ${severity} vulnerability total.`
    );
  }

  return report;
}

export function validateAuditPolicy(policy, lockfilePackages, today) {
  assert(policy.schemaVersion === 2, "Dependency-audit policy must use schema version 2.");
  assert(Array.isArray(policy.exceptions), "Dependency-audit policy exceptions must be an array.");
  const advisoryUrls = new Set();

  return policy.exceptions.map((entry, index) => {
    const label = `Dependency-audit exception ${index + 1}`;
    assert(entry.scope === "development", `${label} must be development-only.`);
    assert(typeof entry.advisory === "string" && entry.advisory.length > 0, `${label} needs an advisory URL.`);
    assert(Array.isArray(entry.packages) && entry.packages.length > 0, `${label} needs affected packages.`);
    assert(severityRank.has(entry.maximumSeverity), `${label} has an invalid maximum severity.`);
    assert(typeof entry.reason === "string" && entry.reason.length > 0, `${label} needs a review reason.`);
    assert(typeof entry.expiresOn === "string" && entry.expiresOn >= today, `${label} expired on ${entry.expiresOn}.`);
    assert(
      entry.reviewedNodes && Object.keys(entry.reviewedNodes).length > 0,
      `${label} needs exact reviewed lockfile nodes.`
    );
    assert(!advisoryUrls.has(entry.advisory), `${label} duplicates advisory ${entry.advisory}.`);
    advisoryUrls.add(entry.advisory);

    for (const [node, version] of Object.entries(entry.reviewedNodes)) {
      const installedVersion = lockfilePackages[node]?.version;
      assert(
        installedVersion === version,
        `${label} reviewed ${node}@${version}, but the lockfile contains ${installedVersion ?? "no matching node"}.`
      );
    }

    return entry;
  });
}

function exceptionCoversVulnerability(vulnerability, entry) {
  if (!entry.packages.includes(vulnerability.name)) return false;

  const severity = severityRank.get(vulnerability.severity) ?? Infinity;
  const maximumSeverity = severityRank.get(entry.maximumSeverity) ?? -1;
  if (severity > maximumSeverity) return false;

  return vulnerability.nodes.every(
    (node) => Object.hasOwn(entry.reviewedNodes, node)
  );
}

function coveringExceptions(vulnerability, exceptions) {
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) return [];

  const matches = [];
  for (const cause of vulnerability.via) {
    const exception = exceptions.find((entry) => {
      if (!exceptionCoversVulnerability(vulnerability, entry)) return false;
      return typeof cause === "string"
        ? entry.packages.includes(cause)
        : cause !== null && cause.url === entry.advisory;
    });
    if (!exception) return [];
    if (!matches.includes(exception)) matches.push(exception);
  }
  return matches;
}

export function evaluateFullTreeAudit(report, exceptions) {
  const unexpected = [];
  const observedAdvisories = new Set();

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const cause of vulnerability.via ?? []) {
      if (cause !== null && typeof cause === "object" && typeof cause.url === "string") {
        observedAdvisories.add(cause.url);
      }
    }

    const matches = coveringExceptions(vulnerability, exceptions);
    if (matches.length === 0) {
      unexpected.push(vulnerability);
    }
  }

  const staleExceptions = exceptions.filter(
    (entry) => !observedAdvisories.has(entry.advisory)
  );

  return { unexpected, staleExceptions };
}

export function summarizeVulnerability(vulnerability) {
  return {
    name: vulnerability.name,
    severity: vulnerability.severity,
    via: vulnerability.via,
    range: vulnerability.range,
    nodes: vulnerability.nodes,
  };
}
