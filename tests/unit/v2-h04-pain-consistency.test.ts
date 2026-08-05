import { describe, expect, it } from "vitest";
import {
  PAIN_EVIDENCE_ALGORITHM_VERSION,
  classifyPainEvidence,
  formatPainEvidence,
  isPositivePainEvidence,
} from "@/lib/pain-evidence";

describe("Repbook v2 H04 pain evidence meaning", () => {
  it("keeps an absent record unknown rather than calling it no pain", () => {
    expect(classifyPainEvidence(null)).toEqual({
      meaning: "unknown",
      algorithmVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
      bodyPart: null,
      severity: null,
      source: null,
    });
    expect(formatPainEvidence(null)).toBe("Pain not recorded (unknown)");
  });

  it("distinguishes explicit no-issue evidence from positive pain", () => {
    const noIssue = { bodyPart: "shoulder", severity: 0, source: "set_flag" };
    const pain = { bodyPart: "shoulder", severity: 4, source: "set_exception" };

    expect(classifyPainEvidence(noIssue).meaning).toBe("explicit_no_issue");
    expect(formatPainEvidence(noIssue)).toBe(
      "Explicit no-issue report: shoulder 0/10",
    );
    expect(isPositivePainEvidence(noIssue)).toBe(false);
    expect(classifyPainEvidence(pain).meaning).toBe("pain");
    expect(isPositivePainEvidence(pain)).toBe(true);
  });

  it.each([
    { bodyPart: "", severity: 4, source: "set_flag" },
    { bodyPart: "shoulder", severity: -1, source: "set_flag" },
    { bodyPart: "shoulder", severity: 11, source: "set_flag" },
    { bodyPart: "shoulder", severity: 2.5, source: "set_flag" },
    { bodyPart: "shoulder", severity: 4, source: "legacy" },
    { bodyPart: "shoulder", severity: 0, source: "set_exception" },
  ])("retains unsupported shapes without using them as pain evidence: %j", (input) => {
    expect(classifyPainEvidence(input).meaning).toBe("unsupported");
    expect(isPositivePainEvidence(input)).toBe(false);
  });
});
