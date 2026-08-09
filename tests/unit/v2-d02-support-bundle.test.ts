import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSupportBundle,
  serializeSupportBundle,
  SUPPORT_BUNDLE_PURPOSE,
  SUPPORT_BUNDLE_REDACTION_VERSION,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  supportBundleFilename,
  type BuildSupportBundleInput,
  type SupportProblemType,
} from "@/lib/support-bundle";

const NOW = "2026-08-08T20:00:00.000Z";
const CORRELATION_ID = "2dc53f9e-d651-4c72-8b07-ca011afa2847";

function input(
  overrides: Partial<BuildSupportBundleInput> = {},
): BuildSupportBundleInput {
  return {
    appVersion: "1.1.1",
    correlationId: CORRELATION_ID,
    generatedAt: NOW,
    problemType: "page_display",
    observedState: "layout_overflow",
    includeDiagnosticContext: true,
    diagnosticContext: {
      status: "populated",
      values: {
        browserFamily: "chromium",
        downloadSupport: true,
        online: true,
        viewportClass: "narrow",
      },
    },
    includeOwnerNote: false,
    ...overrides,
  };
}

describe("Repbook v2 D02 user-previewed support bundle", () => {
  it("builds one versioned, local-only artifact with no stable owner identity", () => {
    const bundle = buildSupportBundle(input());

    expect(bundle).toEqual(
      expect.objectContaining({
        schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
        redactionVersion: SUPPORT_BUNDLE_REDACTION_VERSION,
        purpose: SUPPORT_BUNDLE_PURPOSE,
        correlationId: CORRELATION_ID,
        generatedAt: NOW,
        application: { name: "Repbook", version: "1.1.1" },
        problem: {
          type: "page_display",
          errorCode: "layout_overflow",
        },
        privacy: {
          localExportOnly: true,
          automaticUpload: false,
          stableIdentityIncluded: false,
          automaticTrainingFactCollection: false,
          serverDiagnosticLogLinesIncluded: false,
          aiAnalysisContentIncluded: false,
        },
      }),
    );
    expect(JSON.stringify(bundle)).not.toMatch(
      /ownerId|userId|workoutId|exerciseName|actualWeight|repetitions|providerBody/i,
    );
  });

  it.each([
    ["workout_start", "start_failed", ["online"]],
    ["page_display", "layout_overflow", ["browserFamily", "viewportClass"]],
    [
      "export_or_recovery",
      "download_missing",
      ["browserFamily", "downloadSupport"],
    ],
    ["coach_or_review", "timed_out", ["online"]],
  ] as const)(
    "enforces the %s problem-specific context allowlist",
    (problemType, observedState, expectedKeys) => {
      const diagnosticContext = {
        status: "populated" as const,
        values: {
          browserFamily: "chromium" as const,
          downloadSupport: true,
          online: false,
          viewportClass: "wide" as const,
          ownerId: "owner-private",
          actualWeight: 999,
          repetitions: 99,
          unknownField: "must not pass through",
        },
      };
      const bundle = buildSupportBundle(
        input({
          problemType: problemType as SupportProblemType,
          observedState,
          diagnosticContext: diagnosticContext as BuildSupportBundleInput["diagnosticContext"],
        }),
      );

      expect(bundle.diagnosticContext?.collectionStatus).toBe("populated");
      expect(Object.keys(bundle.diagnosticContext?.observations ?? {}).sort()).toEqual(
        [...expectedKeys].sort(),
      );
      expect(JSON.stringify(bundle)).not.toContain("owner-private");
      expect(JSON.stringify(bundle)).not.toContain("must not pass through");
      expect(JSON.stringify(bundle)).not.toContain("999");
    },
  );

  it("recovers safely from populated, empty, and collection-error context", () => {
    expect(
      buildSupportBundle(input()).diagnosticContext,
    ).toEqual({
      collectionStatus: "populated",
      observations: {
        browserFamily: "chromium",
        viewportClass: "narrow",
      },
    });
    expect(
      buildSupportBundle(
        input({ diagnosticContext: { status: "empty" } }),
      ).diagnosticContext,
    ).toEqual({ collectionStatus: "empty" });
    expect(
      buildSupportBundle(
        input({
          diagnosticContext: {
            status: "error",
            errorCategory: "runtime",
          },
        }),
      ).diagnosticContext,
    ).toEqual({ collectionStatus: "error", errorCategory: "runtime" });
  });

  it("removes optional sections and includes owner text only by deliberate opt-in", () => {
    const minimal = buildSupportBundle(
      input({
        includeDiagnosticContext: false,
        includeOwnerNote: false,
        ownerNote: "SYNTHETIC PRIVATE SUPPORT NOTE",
      }),
    );
    expect(minimal.diagnosticContext).toBeUndefined();
    expect(minimal.ownerProvided).toBeUndefined();
    expect(minimal.inventory.optionalSectionsRemoved).toEqual([
      "diagnosticContext",
      "ownerProvided",
    ]);
    expect(JSON.stringify(minimal)).not.toContain("SYNTHETIC PRIVATE SUPPORT NOTE");

    const optedIn = buildSupportBundle(
      input({
        includeOwnerNote: true,
        ownerNote: "  Synthetic owner-written context only.  ",
      }),
    );
    expect(optedIn.ownerProvided).toEqual({
      freeText: "Synthetic owner-written context only.",
      mayContainPrivateTrainingOrHealthDetails: true,
    });
  });

  it("rejects incompatible outcomes and unsafe or oversized owner text", () => {
    expect(() =>
      buildSupportBundle(
        input({ problemType: "workout_start", observedState: "layout_overflow" }),
      ),
    ).toThrow("belongs to this problem");
    expect(() =>
      buildSupportBundle(
        input({ includeOwnerNote: true, ownerNote: "private\u202Etext" }),
      ),
    ).toThrow("plain-text");
    expect(() =>
      buildSupportBundle(
        input({ includeOwnerNote: true, ownerNote: "x".repeat(501) }),
      ),
    ).toThrow("plain-text");
  });

  it("serializes the exact preview/download bytes and a non-identifying filename", () => {
    const bundle = buildSupportBundle(input());
    const exact = serializeSupportBundle(bundle);
    expect(exact).toBe(`${JSON.stringify(bundle, null, 2)}\n`);
    expect(supportBundleFilename(bundle)).toBe(
      "repbook-support-page_display-2026-08-08.json",
    );
    expect(supportBundleFilename(bundle)).not.toContain(CORRELATION_ID);
  });

  it("has no upload, persistence, log-reuse, or AI-package path", () => {
    const sources = [
      "src/lib/support-bundle.ts",
      "src/components/export/support-bundle-builder.tsx",
      "src/app/(main)/export/support/page.tsx",
    ]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/\bfetch\s*\(/);
    expect(sources).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/);
    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(sources).not.toMatch(/server-log|analysis-package|external-analysis/);
  });
});
