import "server-only";

import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

/**
 * Binds the guided-setup attestation to the exact routine and complete current
 * owner-visible equipment-fit semantics shown on the Review step. The atomic
 * publisher also compares both underlying values so a digest alone cannot
 * bypass a stale tab.
 */
export function createSetupEquipmentFitReviewToken(input: {
  routineDraft: unknown;
  equipmentFitReviewRevision: string;
}): string {
  return sha256Hex(Buffer.from(canonicalJson({
    contract: "setup-equipment-fit-review/1",
    routineDraft: input.routineDraft,
    equipmentFitReviewRevision: input.equipmentFitReviewRevision,
  }), "utf8"));
}
