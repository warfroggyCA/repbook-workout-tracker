import { describe, expect, it } from "vitest";
import {
  evaluateFullTreeAudit,
  validateAuditPolicy,
} from "../../scripts/lib/dependency-audit-policy.mjs";

const advisory = "https://github.com/advisories/GHSA-example";
const reviewedNode = "node_modules/example-tool/node_modules/example-vulnerable";

function policy(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    exceptions: [
      {
        scope: "development",
        advisory,
        packages: ["example-tool", "example-vulnerable"],
        maximumSeverity: "moderate",
        expiresOn: "2026-10-31",
        reason: "Reviewed development-only tool path.",
        reviewedNodes: { [reviewedNode]: "1.2.3" },
        ...overrides,
      },
    ],
  };
}

function report(versionNode = reviewedNode) {
  return {
    vulnerabilities: {
      "example-vulnerable": {
        name: "example-vulnerable",
        severity: "moderate",
        via: [{ url: advisory }],
        range: "<2",
        nodes: [versionNode],
      },
      "example-tool": {
        name: "example-tool",
        severity: "moderate",
        via: ["example-vulnerable"],
        range: "*",
        nodes: ["node_modules/example-tool"],
      },
    },
  };
}

describe("dependency audit policy", () => {
  it("accepts only the exact reviewed development-tool nodes", () => {
    const exactPolicy = policy({
      reviewedNodes: {
        [reviewedNode]: "1.2.3",
        "node_modules/example-tool": "4.5.6",
      },
    });
    const exceptions = validateAuditPolicy(
      exactPolicy,
      {
        [reviewedNode]: { version: "1.2.3" },
        "node_modules/example-tool": { version: "4.5.6" },
      },
      "2026-07-31"
    );

    expect(evaluateFullTreeAudit(report(), exceptions)).toEqual({
      unexpected: [],
      staleExceptions: [],
    });
  });

  it("rejects a reviewed node when its locked version changes", () => {
    expect(() =>
      validateAuditPolicy(
        policy(),
        { [reviewedNode]: { version: "1.2.4" } },
        "2026-07-31"
      )
    ).toThrow(/reviewed .*1\.2\.3.*1\.2\.4/);
  });

  it("rejects expired or non-development exceptions", () => {
    expect(() =>
      validateAuditPolicy(
        policy({ expiresOn: "2026-07-30" }),
        { [reviewedNode]: { version: "1.2.3" } },
        "2026-07-31"
      )
    ).toThrow(/expired/);

    expect(() =>
      validateAuditPolicy(
        policy({ scope: "production" }),
        { [reviewedNode]: { version: "1.2.3" } },
        "2026-07-31"
      )
    ).toThrow(/development-only/);
  });

  it("rejects new advisory nodes and stale exceptions", () => {
    const exactPolicy = policy({
      reviewedNodes: {
        [reviewedNode]: "1.2.3",
        "node_modules/example-tool": "4.5.6",
      },
    });
    const exceptions = validateAuditPolicy(
      exactPolicy,
      {
        [reviewedNode]: { version: "1.2.3" },
        "node_modules/example-tool": { version: "4.5.6" },
      },
      "2026-07-31"
    );

    expect(evaluateFullTreeAudit(report("node_modules/unreviewed"), exceptions)).toEqual({
      unexpected: [report("node_modules/unreviewed").vulnerabilities["example-vulnerable"]],
      staleExceptions: [exceptions[0]],
    });
    expect(evaluateFullTreeAudit({ vulnerabilities: {} }, exceptions)).toEqual({
      unexpected: [],
      staleExceptions: [exceptions[0]],
    });
  });

  it("rejects an additional advisory on an otherwise reviewed node", () => {
    const exceptions = validateAuditPolicy(
      policy(),
      { [reviewedNode]: { version: "1.2.3" } },
      "2026-07-31"
    );
    const baseReport = report();
    const vulnerability = baseReport.vulnerabilities["example-vulnerable"];
    vulnerability.via.push({
      url: "https://github.com/advisories/GHSA-unreviewed",
    });
    const multipleAdvisories = {
      vulnerabilities: { "example-vulnerable": vulnerability },
    };

    expect(evaluateFullTreeAudit(multipleAdvisories, exceptions)).toEqual({
      unexpected: [multipleAdvisories.vulnerabilities["example-vulnerable"]],
      staleExceptions: [exceptions[0]],
    });
  });
});
