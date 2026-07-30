"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { validateEquipmentInventoryDocument } from "@/lib/equipment-inventory-contract";
import { logServerEvent } from "@/lib/server-log";
import {
  previewInventoryDocumentChanges,
  type InventoryChangePreview,
} from "@/services/equipment-inventory";
import {
  saveInventoryDocumentForManagement,
  type ManagementInventorySaveResult,
} from "@/services/setup-persistence";

export type EquipmentPreviewResponse =
  | { ok: true; preview: InventoryChangePreview }
  | {
      ok: false;
      code:
        | "disabled"
        | "invalid"
        | "stale"
        | "ambiguous_bars"
        | "unknown_ids"
        | "failed";
      reason: string;
    };

const DISABLED_REASON =
  "Equipment management is not enabled on this deployment.";

/**
 * Server-computed change and impact review for the returning-user equipment
 * manager. Every check is server-authoritative: the flag, the session, the
 * document validation, and the revision comparison.
 */
export async function previewEquipmentInventorySave(
  input: unknown
): Promise<EquipmentPreviewResponse> {
  if (!isSettingsManagementEnabled()) {
    return { ok: false, code: "disabled", reason: DISABLED_REASON };
  }
  const user = await getCurrentUser();
  const validated = validateEquipmentInventoryDocument(input);
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid",
      reason: validated.issues[0]?.message ?? "Check the equipment values.",
    };
  }
  const db = await getDb();
  let result;
  try {
    result = await previewInventoryDocumentChanges(
      db,
      user.id,
      validated.document
    );
  } catch (error) {
    logServerEvent("error", "equipment.inventory_preview_failed", {
      userId: user.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ok: false,
      code: "failed",
      reason:
        "The inventory review could not be prepared. Your draft is still here; try again.",
    };
  }
  if (!result.ok) {
    return { ok: false, code: result.code, reason: result.reason };
  }
  return { ok: true, preview: result.preview };
}

export type EquipmentSaveResponse =
  | Extract<ManagementInventorySaveResult, { ok: true }>
  | {
      ok: false;
      code:
        | "disabled"
        | "invalid"
        | "stale"
        | "unknown_ids"
        | "ambiguous_bars"
        | "confirmation_required"
        | "failed";
      reason: string;
    };

/**
 * Management-mode inventory save. The atomic statement verifies the revision
 * and every stable ID under the profile lock; on success the routes that
 * render owner equipment data are revalidated before the client navigates.
 */
export async function saveEquipmentInventory(
  input: unknown,
  confirmedCapabilityReduction = false
): Promise<EquipmentSaveResponse> {
  if (!isSettingsManagementEnabled()) {
    return { ok: false, code: "disabled", reason: DISABLED_REASON };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const validated = validateEquipmentInventoryDocument(input);
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid",
      reason: validated.issues[0]?.message ?? "Check the equipment values.",
    };
  }

  // Recompute the exact server preview immediately before the atomic save.
  // A directly invoked action cannot bypass the capability-reduction
  // confirmation merely because the browser normally shows a review screen.
  let reviewed;
  try {
    reviewed = await previewInventoryDocumentChanges(
      db,
      user.id,
      validated.document
    );
  } catch (error) {
    logServerEvent("error", "equipment.inventory_pre_save_check_failed", {
      userId: user.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ok: false,
      code: "failed",
      reason:
        "The inventory could not be checked before saving. Your draft is still here; try again.",
    };
  }
  if (!reviewed.ok) {
    return { ok: false, code: reviewed.code, reason: reviewed.reason };
  }
  if (reviewed.preview.requiresConfirmation && !confirmedCapabilityReduction) {
    return {
      ok: false,
      code: "confirmation_required",
      reason:
        "Review and confirm the listed equipment or capability reductions before saving.",
    };
  }

  let result;
  try {
    result = await saveInventoryDocumentForManagement(
      db,
      user.id,
      validated.document
    );
  } catch (error) {
    logServerEvent("error", "equipment.inventory_save_failed", {
      userId: user.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ok: false,
      code: "failed",
      reason:
        "The equipment inventory could not be saved. Nothing changed, and your draft is still here so you can try again.",
    };
  }
  if (!result.ok) return result;

  revalidatePath("/settings");
  revalidatePath("/settings/equipment");
  revalidatePath("/settings/setup");
  revalidatePath("/today");
  revalidatePath("/program");
  return result;
}
