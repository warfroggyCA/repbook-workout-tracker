import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPBOOK_V2_FIELD_FAMILIES,
  REPBOOK_V2_LIFECYCLE_STAGES,
  REPBOOK_V2_PRODUCT_PACKAGE_SEQUENCE,
} from "@/lib/v2-lifecycle-audit";
import { SIGN_OUT_DEVICE_STORE_KINDS } from "@/lib/sign-out-device-work";
import { RECOVERY_MANIFEST_BY_TABLE } from "@/services/recovery-manifest";

const root = resolve(__dirname, "../..");

describe("R01 portability and lifecycle ownership", () => {
  it("keeps the public verification inventory aligned with every implemented product package", () => {
    const matrix = JSON.parse(
      readFileSync(
        resolve(root, "docs/repbook-v2-verification-matrix.json"),
        "utf8",
      ),
    ) as {
      currentPackage: string;
      currentPackageBaseCommit: string;
      implementedProductPackages: string[];
      verifications: Record<
        string,
        { status: string; implementingPackage: string; testPath: string }
      >;
    };

    expect(matrix.currentPackage).toBe("R01");
    expect(matrix.currentPackageBaseCommit).toBe(
      "ace9b3bf52c4435976cee78b425b895805809d56",
    );
    expect(matrix.implementedProductPackages).toEqual(
      REPBOOK_V2_PRODUCT_PACKAGE_SEQUENCE,
    );
    for (const id of [
      "A05-databaseService",
      "A05-browser",
      "A05-exportImport",
      "A05-restoreRollback",
      "A05-adversarialPrivacy",
      "R01-databaseService",
      "R01-browser",
      "R01-exportImport",
      "R01-restoreRollback",
      "R01-adversarialPrivacy",
    ]) {
      expect(matrix.verifications[id]?.status, id).toBe("current");
      expect(
        existsSync(resolve(root, matrix.verifications[id]?.testPath ?? "")),
        id,
      ).toBe(true);
    }
  });

  it("gives every field family an explicit export/import owner or exclusion", () => {
    for (const family of REPBOOK_V2_FIELD_FAMILIES) {
      for (const stage of REPBOOK_V2_LIFECYCLE_STAGES) {
        const lifecycleOwner = family.lifecycle[stage];
        if (lifecycleOwner.status === "owned") {
          expect(
            existsSync(resolve(root, lifecycleOwner.module)),
            `${family.id}.${stage}: ${lifecycleOwner.module}`,
          ).toBe(true);
        }
      }
      const owner = family.lifecycle.importExport;
      expect(["owned", "not_applicable"]).toContain(owner.status);
      if (owner.status === "owned") {
        expect(existsSync(resolve(root, owner.module)), owner.module).toBe(true);
      } else {
        expect(owner.reason.length).toBeGreaterThan(20);
      }
    }

    expect(
      RECOVERY_MANIFEST_BY_TABLE.analysis_package_manifests,
    ).toMatchObject({
      capture: "excluded_operational",
      restore: { full: "preserve", history: "preserve" },
      retentionClass: "thirty_day_owner_scoped_manifest",
    });
    const analysisFamily = REPBOOK_V2_FIELD_FAMILIES.find(
      (family) => family.id === "analysis_package_receipt",
    );
    expect(analysisFamily?.lifecycle.importExport).toMatchObject({
      status: "owned",
      module: "src/services/analysis-package.ts",
    });

    const deviceFamily = REPBOOK_V2_FIELD_FAMILIES.find(
      (family) => family.id === "device_mutation_queues",
    );
    expect(deviceFamily?.deviceStores).toEqual(SIGN_OUT_DEVICE_STORE_KINDS);
    expect(deviceFamily?.lifecycle.signOutDeviceQueues).toMatchObject({
      status: "owned",
      module: "src/lib/sign-out-device-work.ts",
    });
  });
});
