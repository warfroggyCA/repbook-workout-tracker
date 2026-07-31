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
  const usedExceptions = new Set();
  const observedNodes = new Map(exceptions.map((entry) => [entry.advisory, new Set()]));

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    const matches = coveringExceptions(vulnerability, exceptions);
    if (matches.length === 0) {
      unexpected.push(vulnerability);
      continue;
    }

    for (const exception of matches) {
      usedExceptions.add(exception.advisory);
      const nodes = observedNodes.get(exception.advisory);
      for (const node of vulnerability.nodes) nodes.add(node);
    }
  }

  const staleExceptions = exceptions.filter((entry) => {
    if (!usedExceptions.has(entry.advisory)) return true;
    const nodes = observedNodes.get(entry.advisory);
    return Object.keys(entry.reviewedNodes).some((node) => !nodes.has(node));
  });

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
