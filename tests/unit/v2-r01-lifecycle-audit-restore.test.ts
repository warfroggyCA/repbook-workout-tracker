import { describe, expect, it } from "vitest";
import { REPBOOK_V2_FIELD_FAMILIES } from "@/lib/v2-lifecycle-audit";
import {
  CANONICAL_CAPTURE_TABLES,
  RECOVERY_MANIFEST_BY_TABLE,
} from "@/services/recovery-manifest";

describe("R01 snapshot, restore, rollback, and recovery coverage", () => {
  it("routes every database family through the single recovery manifest", () => {
    for (const family of REPBOOK_V2_FIELD_FAMILIES.filter(
      (candidate) => candidate.durability === "database",
    )) {
      expect(family.lifecycle.snapshot).toMatchObject({
        status: "owned",
        module: "src/services/snapshot-capture.ts",
      });
      expect(family.lifecycle.restore).toMatchObject({
        status: "owned",
        module: "src/services/snapshot-restore.ts",
      });
      expect(family.lifecycle.rollback).toMatchObject({
        status: "owned",
        module: "src/services/snapshot-restore.ts",
      });
      expect(family.lifecycle.recovery).toMatchObject({
        status: "owned",
        module: "src/services/recovery-manifest.ts",
      });

      for (const storage of family.storage) {
        const recovery = RECOVERY_MANIFEST_BY_TABLE[storage.table];
        expect(recovery, `${family.id}.${storage.table}`).toBeDefined();
        expect(recovery.integrityChecks.length).toBeGreaterThan(0);
        if (recovery.capture === "canonical") {
          expect(CANONICAL_CAPTURE_TABLES).toContain(storage.table);
        } else {
          expect(storage.table).toBe("analysis_package_manifests");
          expect(recovery).toMatchObject({
            capture: "excluded_operational",
            restore: { full: "preserve", history: "preserve" },
          });
        }
      }
    }
  });

  it("keeps device work and local support artifacts outside server restore", () => {
    const device = REPBOOK_V2_FIELD_FAMILIES.find(
      (family) => family.id === "device_mutation_queues",
    );
    expect(device?.lifecycle.snapshot.status).toBe("not_applicable");
    expect(device?.lifecycle.restore).toMatchObject({
      status: "owned",
      module: "src/lib/sign-out-device-work.ts",
    });

    for (const id of [
      "structured_diagnostic_events",
      "owner_previewed_support_bundle",
    ]) {
      const family = REPBOOK_V2_FIELD_FAMILIES.find(
        (candidate) => candidate.id === id,
      );
      expect(family?.durability).toBe("ephemeral");
      expect(family?.lifecycle.snapshot.status).toBe("not_applicable");
      expect(family?.lifecycle.restore.status).toBe("not_applicable");
      expect(family?.lifecycle.recovery.status).toBe("not_applicable");
    }
  });
});
