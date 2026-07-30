import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { EquipmentManager } from "@/components/equipment/equipment-manager";

/**
 * Returning-user equipment management (UI-005). Loads the complete lossless
 * inventory document server-side; unavailable while the release switch is off.
 */
export default async function ManageEquipmentPage() {
  if (!isSettingsManagementEnabled()) notFound();
  const user = await getCurrentUser();
  const db = await getDb();
  const loaded = await loadEquipmentInventoryDocument(db, user.id);
  if (!loaded) notFound();

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Manage equipment
        </h1>
      </header>
      <EquipmentManager
        initialDocument={loaded.document}
        profileUnit={loaded.profileUnit}
        definitions={loaded.definitions}
        ambiguousBarTypes={loaded.ambiguousBarTypes}
      />
    </main>
  );
}
