import type { PlateLoadedMachineProfile } from "@/lib/equipment-load-profile-contract";
import type { LoadUnit } from "@/lib/units";

export type ProspectiveMachinePlate = {
  id: string;
  denomination: number | string;
  quantity: number;
  unit: LoadUnit;
};

/**
 * Resolves the live/prospective plate pool for a machine profile.
 *
 * An empty compatible-plate selection is the unrestricted default and uses
 * every owned plate in the machine's unit. A non-empty selection is an
 * equipment-specific restriction. Session snapshots store the resolved rows,
 * so historical consumers never call this resolver or reinterpret old evidence.
 */
export function resolveProspectiveMachinePlates<T extends ProspectiveMachinePlate>(
  profile: Pick<
    PlateLoadedMachineProfile,
    "compatiblePlateIds" | "startingResistanceUnit"
  >,
  ownedPlates: readonly T[],
): T[] {
  if (profile.startingResistanceUnit == null) return [];
  const restrictedIds =
    profile.compatiblePlateIds.length > 0
      ? new Set(profile.compatiblePlateIds)
      : null;
  return ownedPlates.filter(
    (plate) =>
      plate.unit === profile.startingResistanceUnit &&
      (restrictedIds == null || restrictedIds.has(plate.id)),
  );
}
