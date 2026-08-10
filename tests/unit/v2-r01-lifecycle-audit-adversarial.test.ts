import { describe, expect, it } from "vitest";
import {
  REPBOOK_V2_FIELD_FAMILIES,
  type RepbookV2FieldFamily,
  validateRepbookV2LifecycleAudit,
} from "@/lib/v2-lifecycle-audit";

function copyAudit() {
  return structuredClone(
    REPBOOK_V2_FIELD_FAMILIES,
  ) as unknown as RepbookV2FieldFamily[];
}

describe("R01 lifecycle omission refusal", () => {
  it("rejects a duplicated field-family identity", () => {
    const audit = copyAudit();
    audit.push(structuredClone(audit[0]));
    expect(validateRepbookV2LifecycleAudit(audit)).toContain(
      `duplicate family: ${audit[0].id}`,
    );
  });

  it("rejects a missing lifecycle consumer", () => {
    const audit = copyAudit();
    Reflect.deleteProperty(audit[0].lifecycle, "recovery");
    expect(validateRepbookV2LifecycleAudit(audit)).toContain(
      `${audit[0].id}: incomplete lifecycle`,
    );
  });

  it("rejects incomplete storage and unexplained exclusions", () => {
    const audit = copyAudit();
    const storage = audit[0].storage as RepbookV2FieldFamily["storage"][number][];
    storage[0] = {
      ...audit[0].storage[0],
      fields: [],
    };
    audit[1].lifecycle.coach = {
      status: "not_applicable",
      reason: "unknown",
    };
    expect(validateRepbookV2LifecycleAudit(audit)).toEqual(
      expect.arrayContaining([
        `${audit[0].id}: incomplete storage requirement`,
        `${audit[1].id}.coach: incomplete not-applicable reason`,
      ]),
    );
  });

  it("rejects invalid package, device-store, and ephemeral-storage coverage", () => {
    const audit = copyAudit();
    audit[0].packages = ["unknown"] as unknown as RepbookV2FieldFamily["packages"];
    const device = audit.find((family) => family.durability === "device");
    expect(device).toBeDefined();
    device!.deviceStores = ["workout_sets", "workout_sets"];
    const ephemeral = audit.find((family) => family.durability === "ephemeral");
    expect(ephemeral).toBeDefined();
    ephemeral!.storage = [{ table: "owner_data", fields: ["raw"] }];

    expect(validateRepbookV2LifecycleAudit(audit)).toEqual(
      expect.arrayContaining([
        `${audit[0].id}: unknown owning package unknown`,
        `${device!.id}: duplicate device store`,
        `${ephemeral!.id}: non-database family has database storage`,
      ]),
    );
  });
});
