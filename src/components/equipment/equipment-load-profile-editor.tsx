"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EquipmentInventoryItem, PlateInventoryItem } from "@/lib/equipment-inventory-contract";
import type {
  CableMachineProfile,
  EquipmentAttachmentProfile,
  EquipmentLoadProfile,
  PlateLoadedMachineProfile,
} from "@/lib/equipment-load-profile-contract";
import type { LoadUnit } from "@/lib/units";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

type CompatibleItem = { id: string; label: string };

export type EquipmentLoadProfileEditorProps = {
  item: EquipmentInventoryItem;
  profile: EquipmentLoadProfile | null;
  profileUnit: LoadUnit;
  plates: PlateInventoryItem[];
  cableStations: CompatibleItem[];
  attachments: CompatibleItem[];
  onChange: (profile: EquipmentLoadProfile | null) => void;
  compatibleCableStationIds?: string[];
  onCompatibleCableStationIdsChange?: (ids: string[]) => void;
};

export function canEditExactEquipmentProfile(
  item: Pick<EquipmentInventoryItem, "id" | "draftId">,
): boolean {
  return item.id != null || item.draftId != null;
}

export type MachineLoadingMethod = "plate_loaded" | "weight_stack" | "unknown";

export function machineLoadingMethodFor(
  profile: EquipmentLoadProfile | null | undefined,
): MachineLoadingMethod {
  if (profile?.kind === "plate_loaded_machine") return "plate_loaded";
  if (profile?.kind === "cable_machine") return "weight_stack";
  return "unknown";
}

export function summarizeExactEquipmentProfile(
  profile: EquipmentLoadProfile | null | undefined,
): string | null {
  if (!profile) return null;
  if (profile.kind === "plate_loaded_implement") {
    return `Exact ${profile.emptyWeight} ${profile.unit} implement · shared plate pool`;
  }
  if (profile.kind === "plate_loaded_machine") {
    return profile.geometryCertainty === "known"
      ? `Exact machine geometry · ${profile.loadingPointCount} loading ${profile.loadingPointCount === 1 ? "point" : "points"}`
      : profile.geometryCertainty === "partial"
        ? "Machine geometry partly recorded"
        : "Machine geometry unknown";
  }
  if (profile.kind === "cable_machine") {
    return profile.geometryCertainty === "known"
      ? `Exact cable geometry · ${profile.stackCount} ${profile.stackCount === 1 ? "stack" : "stacks"}`
      : profile.geometryCertainty === "partial"
        ? "Cable geometry partly recorded"
        : "Cable geometry unknown";
  }
  return profile.status === "known"
    ? `Known ${profile.attachmentKind.replaceAll("_", " ")} attachment`
    : `${profile.attachmentKind.replaceAll("_", " ")} attachment · connection unknown`;
}

function nullableNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function Field({ id, label, value, min = 0, step = "1", onChange }: {
  id: string;
  label: string;
  value: number | null;
  min?: number;
  step?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input id={id} type="number" inputMode="decimal" min={min} step={step}
        value={value ?? ""} onChange={(event) => onChange(nullableNumber(event.target.value))} />
    </label>
  );
}

function CheckList({ label, options, selected, onChange }: {
  label: string;
  options: CompatibleItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (options.length === 0) return <p className="text-xs text-muted-foreground">No {label.toLowerCase()} are saved.</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-medium">{label}</legend>
      {options.map((option) => (
        <label key={option.id} className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm">
          <input type="checkbox" checked={selected.includes(option.id)} onChange={(event) =>
            onChange((event.target.checked
              ? [...selected, option.id]
              : selected.filter((id) => id !== option.id)).sort())
          } />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function MachinePlateCompatibilityEditor({
  options,
  selected,
  unit,
  onChange,
}: {
  options: CompatibleItem[];
  selected: string[];
  unit: LoadUnit;
  onChange: (ids: string[]) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No owned {unit} plates are saved. Opposite-unit plates are never mixed.
      </p>
    );
  }
  const restricted = selected.length > 0;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-medium">Compatible plate pool</legend>
      <p className="text-xs leading-5 text-muted-foreground">
        {restricted
          ? `Restricted to ${selected.length} selected ${unit} plate ${selected.length === 1 ? "size" : "sizes"}.`
          : `All owned ${unit} plates are available by default.`}
        {" "}Select plate sizes only when this machine has an equipment-specific restriction.
        Opposite-unit plates are never mixed.
      </p>
      {options.map((option) => (
        <label key={option.id} className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={(event) =>
              onChange(
                (event.target.checked
                  ? [...selected, option.id]
                  : selected.filter((id) => id !== option.id)
                ).sort(),
              )
            }
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function RemoveExactSetup({ visible, onRemove }: { visible: boolean; onRemove: () => void }) {
  if (!visible) return null;
  return (
    <Button type="button" variant="outline" className="self-start text-destructive" onClick={onRemove}>
      Remove exact setup
    </Button>
  );
}

export function machineDefault(): PlateLoadedMachineProfile {
  return {
    kind: "plate_loaded_machine", id: null, geometryCertainty: "unknown",
    startingResistance: null, startingResistanceUnit: null, loadingPointCount: null,
    balancingRule: null, targetEntryMeaning: null, compatiblePlateIds: [],
  };
}

export function cableDefault(): CableMachineProfile {
  return {
    kind: "cable_machine", id: null, geometryCertainty: "unknown", stackCount: null,
    topology: null, displayedUnit: null, ratioStatus: "unknown", ratioNumerator: null,
    ratioDenominator: null, stackSteps: [], compatibleAttachmentItemIds: [],
  };
}

function attachmentDefault(): EquipmentAttachmentProfile {
  return { kind: "attachment", id: null, attachmentKind: "other", connectionStandard: null, status: "unknown" };
}

export function MachineLoadingMethodEditor({
  item,
  profile,
  onChange,
}: {
  item: EquipmentInventoryItem;
  profile: EquipmentLoadProfile | null;
  onChange: (next: {
    type: "machine" | "smith_machine" | "cable";
    profile: EquipmentLoadProfile | null;
  }) => void;
}) {
  const currentType =
    item.type === "machine" ||
    item.type === "smith_machine" ||
    item.type === "cable"
      ? item.type
      : null;
  if (currentType == null) return null;
  const method = machineLoadingMethodFor(profile);
  const options: Array<{
    value: MachineLoadingMethod;
    label: string;
    description: string;
  }> = [
    {
      value: "plate_loaded",
      label: "Plate-loaded",
      description: "You add owned weight plates to one or more loading points.",
    },
    {
      value: "weight_stack",
      label: "Weight stack",
      description: "You choose a displayed load with a pin or selector.",
    },
    {
      value: "unknown",
      label: "Not yet known",
      description: "Keep logging the displayed number without calculating effective load.",
    },
  ];
  return (
    <fieldset className="mt-4 flex flex-col gap-2 border-t pt-4">
      <legend className="text-sm font-semibold">How is this machine loaded?</legend>
      <p className="text-xs leading-5 text-muted-foreground">
        Choose the physical loading method. The app will not guess from the machine or exercise name.
      </p>
      {options.map((option) => {
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={method === option.value}
            className={cn(
              "min-h-11 rounded-lg border px-3 py-2 text-left",
              method === option.value
                ? "border-primary bg-primary/10"
                : "bg-background",
            )}
            onClick={() => {
              if (option.value === "plate_loaded") {
                onChange({
                  type:
                    currentType === "smith_machine" ? "smith_machine" : "machine",
                  profile:
                    profile?.kind === "plate_loaded_machine"
                      ? profile
                      : machineDefault(),
                });
              } else if (option.value === "weight_stack") {
                onChange({
                  type: "cable",
                  profile:
                    profile?.kind === "cable_machine"
                      ? profile
                      : cableDefault(),
                });
              } else {
                onChange({
                  type: currentType,
                  profile: null,
                });
              }
            }}
          >
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
              {option.description}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

export function EquipmentLoadProfileEditor({ item, profile, profileUnit, plates, cableStations, attachments, onChange, compatibleCableStationIds = [], onCompatibleCableStationIdsChange }: EquipmentLoadProfileEditorProps) {
  const prefix = `exact-${item.id ?? "new"}`;
  if (item.type === "trap_bar" || (item.type === "other" && profile?.kind === "plate_loaded_implement")) {
    const implement = profile?.kind === "plate_loaded_implement" ? profile : null;
    return (
      <section aria-label="Exact specialty implement setup" className="mt-4 rounded-lg border bg-muted/20 p-3">
        <h3 className="text-sm font-semibold">Exact loading setup</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {implement
            ? `Recorded empty implement ${implement.emptyWeight} ${implement.unit}; collars ${implement.collarWeight} ${implement.unit} total. It uses the shared account plate pool, including every owned plate size in balanced pairs.`
            : "No reviewed specialty loading profile is recorded."}
        </p>
      </section>
    );
  }
  if (
    item.type === "barbell" ||
    item.type === "ez_bar"
  ) {
    return (
      <section aria-label="Exact bar setup" className="mt-4 rounded-lg border bg-muted/20 p-3">
        <h3 className="text-sm font-semibold">Exact loading setup</h3>
        {profile?.kind === "plate_loaded_implement" ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The recorded empty implement and collar weights are exact. This {item.type === "ez_bar" ? "EZ-curl" : "Olympic"} implement uses the shared account plate pool; every owned plate size may be used in balanced pairs.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This legacy bar does not yet have a reviewed physical-item link. Saving its recorded empty and collar weights will establish that exact link only when the item/configuration match is unambiguous.
          </p>
        )}
      </section>
    );
  }

  if (
    (item.type === "machine" || item.type === "smith_machine") &&
    profile?.kind === "plate_loaded_machine"
  ) {
    const value = profile;
    const setCertainty = (certainty: PlateLoadedMachineProfile["geometryCertainty"]) => onChange({
      ...value,
      geometryCertainty: certainty,
      ...(certainty === "unknown" ? {
        startingResistance: null, startingResistanceUnit: null, loadingPointCount: null,
        balancingRule: null, targetEntryMeaning: null,
      } : {}),
    });
    return (
      <section aria-label="Exact plate-loaded machine setup" className="mt-4 flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Exact plate-loaded setup</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Record only what is known. Starting resistance is the machine-wide resistance before plates are added.
        </p>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Calculation certainty
          <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.geometryCertainty} onChange={(event) => setCertainty(event.target.value as PlateLoadedMachineProfile["geometryCertainty"])}>
            <option value="unknown">Unknown — do not calculate</option>
            <option value="partial">Partly known</option>
            <option value="known">Known and reviewed</option>
          </select>
        </label>
        {value.geometryCertainty !== "unknown" && <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field id={`${prefix}-resistance`} label={`Starting resistance (${profileUnit})`} value={value.startingResistance} step="0.25" onChange={(startingResistance) => onChange({ ...value, startingResistance, startingResistanceUnit: startingResistance == null ? null : profileUnit })} />
            <Field id={`${prefix}-points`} label="Loading points" value={value.loadingPointCount} min={1} onChange={(loadingPointCount) => onChange({ ...value, loadingPointCount })} />
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">How loading points are balanced
            <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.balancingRule ?? ""} onChange={(event) => onChange({ ...value, balancingRule: event.target.value ? event.target.value as PlateLoadedMachineProfile["balancingRule"] : null })}>
              <option value="">Not recorded</option><option value="single_point">One loading point</option><option value="identical_each_point">All points match</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Entered workout load means
            <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.targetEntryMeaning ?? ""} onChange={(event) => onChange({ ...value, targetEntryMeaning: event.target.value ? event.target.value as PlateLoadedMachineProfile["targetEntryMeaning"] : null })}>
              <option value="">Not recorded</option><option value="total_system">Total resistance</option><option value="per_loading_point">Added plates per point</option>
            </select>
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            Total resistance includes the machine&apos;s starting resistance. Per-point entry means only the plates added to each matching loading point.
          </p>
        </>}
        <MachinePlateCompatibilityEditor
          options={plates.flatMap((plate) => plate.id ? [{ id: plate.id, label: `${plate.denomination} ${profileUnit} · ${plate.quantity} owned` }] : [])}
          selected={value.compatiblePlateIds}
          unit={profileUnit}
          onChange={(compatiblePlateIds) => onChange({ ...value, compatiblePlateIds })}
        />
        <RemoveExactSetup visible={profile?.kind === "plate_loaded_machine"} onRemove={() => onChange(null)} />
      </section>
    );
  }

  if (item.type === "cable" && profile?.kind === "cable_machine") {
    const value = profile;
    const setCertainty = (certainty: CableMachineProfile["geometryCertainty"]) => onChange({
      ...value, geometryCertainty: certainty,
      ...(certainty === "unknown" ? { stackCount: null, topology: null, displayedUnit: null, ratioStatus: "unknown" as const, ratioNumerator: null, ratioDenominator: null, stackSteps: [] } : {}),
    });
    return (
      <section aria-label="Exact cable setup" className="mt-4 flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Exact weight-stack setup</h3>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Geometry certainty
          <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.geometryCertainty} onChange={(event) => setCertainty(event.target.value as CableMachineProfile["geometryCertainty"])}>
            <option value="unknown">Unknown — do not calculate</option><option value="partial">Partly known</option><option value="known">Known and reviewed</option>
          </select>
        </label>
        {value.geometryCertainty !== "unknown" && <>
          <Field id={`${prefix}-stacks`} label="Number of stacks" value={value.stackCount} min={1} onChange={(stackCount) => onChange({ ...value, stackCount })} />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Stack topology
            <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.topology ?? ""} onChange={(event) => onChange({ ...value, topology: event.target.value ? event.target.value as CableMachineProfile["topology"] : null, stackSteps: [] })}>
              <option value="">Not recorded</option><option value="shared_selection">One shared selection</option><option value="independent_per_stack">Each stack selected separately</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Pulley ratio
            <select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.ratioStatus} onChange={(event) => onChange({ ...value, ratioStatus: event.target.value as CableMachineProfile["ratioStatus"], ratioNumerator: null, ratioDenominator: null })}>
              <option value="unknown">Unknown — do not derive resistance</option><option value="known">Known rational ratio</option>
            </select>
          </label>
          {value.ratioStatus === "known" && <div className="grid grid-cols-2 gap-2"><Field id={`${prefix}-ratio-n`} label="Ratio numerator" value={value.ratioNumerator} min={1} onChange={(ratioNumerator) => onChange({ ...value, ratioNumerator })} /><Field id={`${prefix}-ratio-d`} label="Ratio denominator" value={value.ratioDenominator} min={1} onChange={(ratioDenominator) => onChange({ ...value, ratioDenominator })} /></div>}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between"><h4 className="text-xs font-medium">Recorded stack positions ({profileUnit})</h4><Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, displayedUnit: profileUnit, stackSteps: [...value.stackSteps, { id: null, stackIndex: value.topology === "independent_per_stack" ? 1 : 0, stepIndex: value.stackSteps.length, displayedLoad: 0, positionLabel: null }] })}><Plus className="size-3.5" /> Add</Button></div>
            {value.stackSteps.map((step, index) => <div key={`${step.id ?? "new"}-${index}`} className="grid grid-cols-2 gap-2 rounded-md border p-2">
              {value.topology === "independent_per_stack" && <Field id={`${prefix}-stack-${index}`} label="Stack number" value={step.stackIndex} min={1} onChange={(stackIndex) => onChange({ ...value, stackSteps: value.stackSteps.map((entry, i) => i === index ? { ...entry, stackIndex: stackIndex ?? 1 } : entry) })} />}
              <Field id={`${prefix}-ordinal-${index}`} label="Position number" value={step.stepIndex} min={0} onChange={(stepIndex) => onChange({ ...value, stackSteps: value.stackSteps.map((entry, i) => i === index ? { ...entry, stepIndex: stepIndex ?? 0 } : entry) })} />
              <Field id={`${prefix}-step-${index}`} label="Displayed load" value={step.displayedLoad} step="0.25" onChange={(displayedLoad) => onChange({ ...value, displayedUnit: profileUnit, stackSteps: value.stackSteps.map((entry, i) => i === index ? { ...entry, displayedLoad: displayedLoad ?? 0 } : entry) })} />
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Position label<Input value={step.positionLabel ?? ""} maxLength={80} onChange={(event) => onChange({ ...value, stackSteps: value.stackSteps.map((entry, i) => i === index ? { ...entry, positionLabel: event.target.value.trim() || null } : entry) })} /></label>
              <Button type="button" variant="ghost" size="sm" className="col-span-2 justify-self-end" aria-label={`Remove stack position ${index + 1}`} onClick={() => onChange({ ...value, stackSteps: value.stackSteps.filter((_, i) => i !== index) })}><X className="size-4" /> Remove</Button>
            </div>)}
          </div>
        </>}
        <CheckList label="Compatible attachments" options={attachments} selected={value.compatibleAttachmentItemIds} onChange={(compatibleAttachmentItemIds) => onChange({ ...value, compatibleAttachmentItemIds })} />
        <RemoveExactSetup visible={profile?.kind === "cable_machine"} onRemove={() => onChange(null)} />
      </section>
    );
  }

  if (item.type === "other") {
    const value = profile?.kind === "attachment" ? profile : attachmentDefault();
    return (
      <section aria-label="Cable attachment setup" className="mt-4 flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Cable attachment setup</h3>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Attachment kind<select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.attachmentKind} onChange={(event) => onChange({ ...value, attachmentKind: event.target.value as EquipmentAttachmentProfile["attachmentKind"] })}><option value="rope">Rope</option><option value="straight_bar">Straight bar</option><option value="lat_bar">Lat bar</option><option value="v_bar">V bar</option><option value="single_handle">Single handle</option><option value="ankle_cuff">Ankle cuff</option><option value="other">Other</option></select></label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Connection standard<Input value={value.connectionStandard ?? ""} maxLength={120} placeholder="Unknown" onChange={(event) => onChange({ ...value, connectionStandard: event.target.value.trim() || null })} /></label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Connection certainty<select className="h-11 rounded-md border bg-background px-3 text-sm text-foreground" value={value.status} onChange={(event) => onChange({ ...value, status: event.target.value as EquipmentAttachmentProfile["status"] })}><option value="unknown">Unknown</option><option value="known">Known</option></select></label>
        <CheckList label="Compatible cable stations" options={cableStations} selected={compatibleCableStationIds} onChange={(ids) => onCompatibleCableStationIdsChange?.(ids)} />
        <RemoveExactSetup visible={profile?.kind === "attachment"} onRemove={() => onChange(null)} />
      </section>
    );
  }
  return null;
}
