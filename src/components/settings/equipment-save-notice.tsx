"use client";

import { useEffect } from "react";

/**
 * After a successful equipment save, Settings announces the result and moves
 * focus to the Equipment section heading so the fresh inventory is where the
 * user lands.
 */
export function EquipmentSaveNotice({ result }: { result: "updated" | "unchanged" }) {
  useEffect(() => {
    const heading = document.getElementById("settings-equipment-heading");
    heading?.focus();
  }, []);

  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-md bg-primary/10 px-3 py-2 text-sm text-foreground"
    >
      {result === "updated"
        ? "Your equipment inventory was saved. The list below is the current inventory."
        : "No equipment changes were needed — your inventory is unchanged."}
    </p>
  );
}
