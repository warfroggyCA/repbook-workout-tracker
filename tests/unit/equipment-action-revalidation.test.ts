import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  previewInventoryDocumentChanges: vi.fn(),
  saveInventoryDocumentForManagement: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/db", () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => ({
    id: "2e161758-4a82-4306-986e-e41414750c55",
  })),
}));
vi.mock("@/lib/settings-management-feature", () => ({
  isSettingsManagementEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/equipment-inventory-contract", () => ({
  validateEquipmentInventoryDocument: vi.fn(() => ({
    ok: true,
    document: { schemaVersion: 1, revision: 0, items: [] },
  })),
}));
vi.mock("@/lib/server-log", () => ({
  categorizeDiagnosticError: vi.fn((_error, fallback) => fallback),
  logDiagnosticEvent: vi.fn(),
}));
vi.mock("@/services/equipment-inventory", () => ({
  previewInventoryDocumentChanges: mocks.previewInventoryDocumentChanges,
}));
vi.mock("@/services/setup-persistence", () => ({
  saveInventoryDocumentForManagement:
    mocks.saveInventoryDocumentForManagement,
}));

import { saveEquipmentInventory } from "@/app/actions/equipment";

describe("equipment save route revalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewInventoryDocumentChanges.mockResolvedValue({
      ok: true,
      preview: { requiresConfirmation: false },
    });
    mocks.saveInventoryDocumentForManagement.mockResolvedValue({
      ok: true,
      revision: 1,
    });
  });

  it("refreshes upcoming active-workout guidance after a successful save", async () => {
    await expect(saveEquipmentInventory({})).resolves.toMatchObject({ ok: true });

    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/session/[id]",
      "page",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
  });

  it("does not refresh any workout when the save fails", async () => {
    mocks.saveInventoryDocumentForManagement.mockResolvedValue({
      ok: false,
      code: "stale",
      reason: "Refresh equipment and review again.",
    });

    await expect(saveEquipmentInventory({})).resolves.toMatchObject({
      ok: false,
      code: "stale",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
