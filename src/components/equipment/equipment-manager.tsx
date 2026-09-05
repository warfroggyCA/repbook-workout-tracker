"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Pencil, Plus, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EQUIPMENT_FAMILIES,
  familyForEquipmentType,
  labelForEquipmentType,
  type EquipmentFamilyKey,
} from "@/lib/equipment-families";
import { EquipmentFamilyIcon } from "@/components/equipment/equipment-family-icon";
import {
  COMMON_BAR_WEIGHTS,
  EQUIPMENT_TYPE_VALUES,
  associateBarConfigurations,
  barTypeForEquipmentItem,
  fixedHandheldWeightStatus,
  hasSparePlate,
  validateEquipmentInventoryDocument,
  type BarConfigurationItem,
  type CanonicalEquipmentType,
  type EquipmentInventoryDocument,
  type InventoryValidationIssue,
} from "@/lib/equipment-inventory-contract";
import {
  EquipmentItemEditor,
  RemoveItemButton,
  type DraftEquipmentItem,
} from "@/components/equipment/equipment-item-editor";
import {
  PlateInventoryEditor,
  type DraftPlate,
} from "@/components/equipment/plate-inventory-editor";
import { InventoryChangeReview } from "@/components/equipment/inventory-change-review";
import {
  previewEquipmentInventorySave,
  saveEquipmentInventory,
} from "@/app/actions/equipment";
import type { InventoryChangePreview } from "@/services/equipment-inventory";
import { MAX_STORED_LOAD, type LoadUnit } from "@/lib/units";
import { equipmentLoadProfileSchema, type EquipmentLoadProfile } from "@/lib/equipment-load-profile-contract";
import {
  canEditExactEquipmentProfile,
  MachineLoadingMethodEditor,
  EquipmentLoadProfileEditor,
  summarizeExactEquipmentProfile,
} from "@/components/equipment/equipment-load-profile-editor";

type DraftBar = BarConfigurationItem & { clientKey: string };

/** Which detail drawer, if any, is open. */
type EditingTarget =
  | { kind: "item"; clientKey: string }
  | { kind: "plates" }
  | null;

export type EquipmentManagerProps = {
  initialDocument: EquipmentInventoryDocument;
  profileUnit: LoadUnit;
  definitions: Array<{ itemId: string; label: string; description: string | null }>;
  ambiguousBarTypes: string[];
  /** Fixed continuation used when this editor is embedded in Review setup. */
  reviewNextHref?: string;
  cancelHref?: string;
  attentionItemIds?: string[];
  attentionRequested?: boolean;
};

function withoutClientKey<T extends { clientKey: string }>(
  row: T
): Omit<T, "clientKey"> {
  const { clientKey, ...rest } = row;
  void clientKey;
  return rest;
}

function canonicalDocument(document: EquipmentInventoryDocument): string {
  return JSON.stringify({
    items: [...document.items].sort((a, b) =>
      (a.id ?? "~new").localeCompare(b.id ?? "~new") || a.label.localeCompare(b.label)
    ),
    plates: [...document.plates].sort((a, b) => a.denomination - b.denomination),
    bars: [...document.bars].sort((a, b) => a.barType.localeCompare(b.barType)),
    loadProfiles: [...(document.loadProfiles ?? [])].sort((a, b) =>
      a.equipmentItemId.localeCompare(b.equipmentItemId)
    ),
  });
}

const PICKER_EXCLUDED_TYPES = new Set<CanonicalEquipmentType>([
  "bodyweight",
  "plates",
]);

function pickerGroups(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return EQUIPMENT_FAMILIES.flatMap((family) => {
    if (family.key === "no_equipment" || family.key === "uncategorized") return [];
    const types = EQUIPMENT_TYPE_VALUES.filter(
      (type) =>
        !PICKER_EXCLUDED_TYPES.has(type) &&
        familyForEquipmentType(type) === family.key &&
        (normalized === "" ||
          labelForEquipmentType(type).toLocaleLowerCase().includes(normalized) ||
          type.replaceAll("_", " ").includes(normalized))
    );
    return types.length > 0 ? [{ family, types }] : [];
  });
}

/** Total individual plates across the pool, for the summary card. */
function totalPlates(plates: DraftPlate[]): number {
  return plates.reduce((sum, plate) => sum + plate.quantity, 0);
}

/**
 * Returning-user equipment manager (UI-005/UI-006). Presents the complete
 * lossless inventory as a scannable card grid; editing happens in a focused
 * slide-over drawer with a pinned Save/Cancel footer. Saves go through the
 * management-mode atomic boundary after a server-computed review.
 */
export function EquipmentManager({
  initialDocument,
  profileUnit,
  definitions,
  ambiguousBarTypes,
  reviewNextHref,
  cancelHref = "/settings",
  attentionItemIds = [],
  attentionRequested = false,
}: EquipmentManagerProps) {
  const router = useRouter();
  const compatibilityItems = useMemo(
    () =>
      initialDocument.items.filter(
        (item) => item.type === "plates" || item.type === "bodyweight"
      ),
    [initialDocument.items]
  );
  const [items, setItems] = useState<DraftEquipmentItem[]>(() =>
    initialDocument.items
      .filter((item) => item.type !== "plates" && item.type !== "bodyweight")
      .map((item) => ({
        ...item,
        clientKey: item.id ?? item.draftId ?? crypto.randomUUID(),
      }))
  );
  const [removedItems, setRemovedItems] = useState<DraftEquipmentItem[]>([]);
  const [plates, setPlates] = useState<DraftPlate[]>(() =>
    initialDocument.plates.map((plate) => ({
      ...plate,
      clientKey: plate.id ?? crypto.randomUUID(),
    }))
  );
  const [bars, setBars] = useState<DraftBar[]>(() =>
    initialDocument.bars.map((bar) => ({ ...bar, clientKey: bar.id ?? crypto.randomUUID() }))
  );
  const [removedBars, setRemovedBars] = useState<DraftBar[]>([]);
  const [loadProfiles, setLoadProfiles] = useState(() => initialDocument.loadProfiles ?? []);
  const [editing, setEditing] = useState<EditingTarget>(() => {
    const matching = initialDocument.items.filter((item) => item.id != null && attentionItemIds.includes(item.id));
    return matching.length === 1 ? { kind: "item", clientKey: matching[0].id! } : null;
  });
  const [stagedItemMessage, setStagedItemMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<"editing" | "review">("editing");
  const [preview, setPreview] = useState<InventoryChangePreview | null>(null);
  const [issues, setIssues] = useState<InventoryValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const definitionByItem = useMemo(
    () => new Map(definitions.map((definition) => [definition.itemId, definition])),
    [definitions]
  );

  const draftDocument: EquipmentInventoryDocument = useMemo(
    () => ({
      baseRevision: initialDocument.baseRevision,
      items: [
        ...compatibilityItems,
        ...items.map((item) => ({
          ...withoutClientKey(item),
          label: item.label.trim(),
        })),
      ],
      plates: plates.map((plate) => withoutClientKey(plate)),
      bars: bars.map((bar) => ({
        ...withoutClientKey(bar),
        label: bar.label.trim(),
      })),
      loadProfiles,
    }),
    [initialDocument.baseRevision, compatibilityItems, items, plates, bars, loadProfiles]
  );

  const dirty = useMemo(
    () => canonicalDocument(draftDocument) !== canonicalDocument(initialDocument),
    [draftDocument, initialDocument]
  );

  // Item content that differs from the loaded row earns an "Edited" chip.
  const initialItemFingerprint = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of initialDocument.items) {
      if (item.id == null) continue;
      map.set(item.id, JSON.stringify({ label: item.label, quantity: item.quantity, attrs: item.attrs }));
    }
    return map;
  }, [initialDocument.items]);
  const initialProfileFingerprint = useMemo(
    () => new Map(
      (initialDocument.loadProfiles ?? []).map((entry) => [
        entry.equipmentItemId,
        JSON.stringify(entry.profile),
      ]),
    ),
    [initialDocument.loadProfiles],
  );

  const platesDirty = useMemo(() => {
    const before = [...initialDocument.plates]
      .sort((a, b) => a.denomination - b.denomination)
      .map((plate) => `${plate.denomination}:${plate.quantity}`)
      .join("|");
    const after = [...plates]
      .sort((a, b) => a.denomination - b.denomination)
      .map((plate) => `${plate.denomination}:${plate.quantity}`)
      .join("|");
    return before !== after;
  }, [initialDocument.plates, plates]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const guardInAppLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash
      ) {
        return;
      }
      event.preventDefault();
      setPendingDestination(`${destination.pathname}${destination.search}${destination.hash}`);
      setCancelOpen(true);
    };
    document.addEventListener("click", guardInAppLink, true);
    return () => document.removeEventListener("click", guardInAppLink, true);
  }, [dirty]);

  const status = pending
    ? phase === "review"
      ? "Saving your inventory…"
      : "Calculating the change review…"
    : error
      ? `Error: ${error}`
      : "";

  const barAssociation = useMemo(
    () => associateBarConfigurations(items, bars),
    [items, bars]
  );
  const barIndexByItemKey = useMemo(
    () => new Map(
      barAssociation.matched.map(({ itemIndex, barIndex }) => [
        items[itemIndex].clientKey,
        barIndex,
      ])
    ),
    [barAssociation, items]
  );

  /** Apply a committed drawer edit of one item plus its associated bar. */
  function commitItemEdit(
    next: DraftEquipmentItem,
    bar: DraftBar | null,
    profile: EquipmentLoadProfile | null,
    compatibleCableStationIds: string[],
  ) {
    const barIndex = barIndexByItemKey.get(next.clientKey);
    setBars((current) => {
      let updated = current;
      if (barIndex != null) {
        updated = updated.map((row, index) =>
          index === barIndex
            ? { ...row, label: next.label, quantity: next.quantity }
            : row
        );
      }
      if (bar) {
        const exists = updated.some((row) => row.clientKey === bar.clientKey);
        updated = exists
          ? updated.map((row) => (row.clientKey === bar.clientKey ? bar : row))
          : [...updated, bar];
      }
      return updated;
    });
    setItems((current) =>
      current.map((item) => (item.clientKey === next.clientKey ? next : item))
    );
    const itemIdentity = next.id ?? next.draftId;
    if (itemIdentity) {
      const exactProfile = bar && (next.type === "barbell" || next.type === "ez_bar")
        ? {
            kind: "plate_loaded_implement" as const,
            id: profile?.kind === "plate_loaded_implement" ? profile.id : bar.id,
            loadingKind: next.type === "ez_bar" ? "ez" as const : "olympic" as const,
            emptyWeight: bar.barWeight,
            collarWeight: bar.collarWeight,
            unit: profileUnit,
            sharedPlatePoolCompatible: true,
          }
        : profile;
      setLoadProfiles((current) => {
        const retained = current.filter((entry) => entry.equipmentItemId !== itemIdentity);
        const withProfile = exactProfile
          ? [...retained, { equipmentItemId: itemIdentity, profile: exactProfile }]
          : retained;
        if (next.type !== "other") return withProfile;
        return withProfile.map((entry) =>
          entry.profile.kind === "cable_machine"
            ? {
                ...entry,
                profile: {
                  ...entry.profile,
                  compatibleAttachmentItemIds: compatibleCableStationIds.includes(entry.equipmentItemId)
                    ? [...new Set([...entry.profile.compatibleAttachmentItemIds, itemIdentity])].sort()
                    : entry.profile.compatibleAttachmentItemIds.filter((id) => id !== itemIdentity),
                },
              }
            : entry
        );
      });
    }
  }

  function removeItem(item: DraftEquipmentItem) {
    const barIndex = barIndexByItemKey.get(item.clientKey);
    if (barIndex != null) {
      const bar = bars[barIndex];
      setBars((current) => current.filter((_, index) => index !== barIndex));
      setRemovedBars((current) => [...current, bar]);
    }
    setItems((current) => current.filter((row) => row.clientKey !== item.clientKey));
    if (item.id != null) {
      setRemovedItems((current) => [...current, item]);
    }
  }

  function restoreItem(item: DraftEquipmentItem) {
    setRemovedItems((current) =>
      current.filter((row) => row.clientKey !== item.clientKey)
    );
    setItems((current) => [...current, item]);
    const barType = barTypeForEquipmentItem(item.type);
    if (barType) {
      const removedBar = removedBars.find((bar) => bar.barType === barType);
      if (removedBar) {
        setRemovedBars((current) =>
          current.filter((bar) => bar.clientKey !== removedBar.clientKey)
        );
        setBars((current) => [...current, removedBar]);
      }
    }
  }

  function addItem(type: CanonicalEquipmentType) {
    const draftId = crypto.randomUUID();
    const item: DraftEquipmentItem = {
      clientKey: draftId,
      id: null,
      draftId,
      type,
      label: labelForEquipmentType(type),
      quantity: 1,
      attrs: {},
    };
    setItems((current) => [...current, item]);
    setAddOpen(false);
    setAddQuery("");
    setEditing({ kind: "item", clientKey: item.clientKey });
  }

  function issueTarget(issue: InventoryValidationIssue): {
    id: string;
    editing: EditingTarget;
  } {
    const itemMatch = /^items\.(\d+)(?:\.(.*))?$/.exec(issue.path);
    if (itemMatch) {
      const item = items[Number(itemMatch[1]) - compatibilityItems.length];
      if (item) {
        const field = itemMatch[2] ?? "";
        const suffix = field === "label"
          ? "label"
          : field.endsWith("minWeight")
            ? "min-weight"
            : field.endsWith("maxWeight")
              ? "max-weight"
              : "label";
        return {
          id: `equipment-${item.clientKey}-${suffix}`,
          editing: { kind: "item", clientKey: item.clientKey },
        };
      }
    }
    if (issue.path.startsWith("plates.")) {
      return { id: "add-plate-weight", editing: { kind: "plates" } };
    }
    if (issue.path.startsWith("bars.")) {
      return { id: "unmatched-bar-configurations", editing: null };
    }
    const profileMatch = /^loadProfiles\.(\d+)/.exec(issue.path);
    if (profileMatch) {
      const entry = loadProfiles[Number(profileMatch[1])];
      const item = entry
        ? items.find((candidate) => candidate.id === entry.equipmentItemId)
        : null;
      if (item) {
        return {
          id: `equipment-card-${item.clientKey}`,
          editing: { kind: "item", clientKey: item.clientKey },
        };
      }
    }
    return { id: "equipment-inventory-editor", editing: null };
  }

  function focusIssue(issue: InventoryValidationIssue) {
    const target = issueTarget(issue);
    if (target.editing) setEditing(target.editing);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.getElementById(target.id)?.focus())
    );
  }

  function startReview() {
    setError(null);
    setIssues([]);
    const validation = validateEquipmentInventoryDocument(draftDocument);
    if (!validation.ok) {
      setIssues(validation.issues);
      focusIssue(validation.issues[0]);
      return;
    }
    startTransition(async () => {
      let result;
      try {
        result = await previewEquipmentInventorySave(draftDocument);
      } catch {
        setError(
          "The inventory review could not be reached. Your draft is still here; check your connection and try again."
        );
        return;
      }
      if (!result.ok) {
        if (result.code === "stale") setStaleConflict(true);
        else setError(result.reason);
        return;
      }
      setPreview(result.preview);
      setPhase("review");
    });
  }

  function save(confirmedCapabilityReduction: boolean) {
    setError(null);
    startTransition(async () => {
      let result;
      try {
        result = await saveEquipmentInventory(
          draftDocument,
          confirmedCapabilityReduction
        );
      } catch {
        setError(
          "The inventory save could not be confirmed. Your draft is still here. Review the current inventory before retrying; the save may have completed."
        );
        return;
      }
      if (!result.ok) {
        if (result.code === "stale") {
          setStaleConflict(true);
          setPhase("editing");
        } else {
          setError(result.reason);
        }
        return;
      }
      router.push(
        reviewNextHref ??
          `/settings?equipment-saved=${result.changed ? "updated" : "unchanged"}`
      );
    });
  }

  function cancel() {
    if (dirty) {
      setPendingDestination(cancelHref);
      setCancelOpen(true);
    }
    else router.push(cancelHref);
  }

  const groupedItems = useMemo(() => {
    const groups = new Map<EquipmentFamilyKey, DraftEquipmentItem[]>();
    for (const item of items) {
      const key = familyForEquipmentType(item.type);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return EQUIPMENT_FAMILIES.flatMap((family) => {
      const familyItems = groups.get(family.key);
      return familyItems || family.key === "bars_and_plates"
        ? [{ family, items: familyItems ?? [] }]
        : [];
    });
  }, [items]);

  const unmatchedBars = barAssociation.unmatchedBarIndexes.map((index) => bars[index]);

  const editingItem =
    editing?.kind === "item"
      ? items.find((item) => item.clientKey === editing.clientKey) ?? null
      : null;

  if (phase === "review" && preview) {
    return (
      <div className="flex flex-col gap-3">
        <InventoryChangeReview
          preview={preview}
          unit={profileUnit}
          pending={pending}
          onBack={() => {
            setPhase("editing");
            setPreview(null);
          }}
          onConfirm={save}
        />
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <p aria-live="polite" role="status" className="sr-only">
          {status}
        </p>
      </div>
    );
  }

  return (
    <div id="equipment-inventory-editor" tabIndex={-1} className="flex flex-col gap-4 pb-44 outline-none lg:pb-24 [&_button]:min-h-11 [&_button]:min-w-11">
      <p className="text-sm leading-6 text-muted-foreground">
        Equipment changes affect which exercises, workout alternatives, and
        plate calculations are available. They do not edit your current
        Program or any workout. Bodyweight training is always available and
        does not need an inventory item.
      </p>

      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="size-4" /> Add equipment
      </Button>

      {attentionRequested && attentionItemIds.length === 0 && (
        <p role="status" className="rounded-lg border border-amber-500/50 p-3 text-sm">No saved item matches this equipment requirement. Add it if you own it, or return to the workout to replace or skip the exercise.</p>
      )}
      {attentionItemIds.length > 0 && (
        <section aria-label="Equipment to review" className="rounded-xl border border-amber-500/50 p-3">
          <h2 className="text-sm font-semibold">Equipment to review</h2>
          <p className="text-xs text-muted-foreground">Check these saved items against the requirement shown in your workout.</p>
          {items.filter((item) => item.id != null && attentionItemIds.includes(item.id)).map((item) => (
            <Button key={item.clientKey} variant="outline" className="mt-2 min-h-11" onClick={() => setEditing({ kind: "item", clientKey: item.clientKey })}>Review {item.label}</Button>
          ))}
        </section>
      )}
      {stagedItemMessage && <p role="status" className="rounded-lg border bg-muted/20 p-3 text-sm">{stagedItemMessage} <Button variant="outline" className="mt-2 min-h-11" disabled={pending} onClick={startReview}>Review and save inventory</Button></p>}
      {staleConflict && (
        <div
          role="alertdialog"
          aria-label="Inventory changed elsewhere"
          className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3"
        >
          <p className="text-sm font-medium">
            Your inventory changed somewhere else after this page loaded.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing was saved. Reload to start from the current inventory, or
            keep reviewing this draft — it cannot be saved over the newer data.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              onClick={() => window.location.reload()}
            >
              Reload current inventory
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => setStaleConflict(false)}
            >
              Keep reviewing
            </Button>
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm font-medium text-destructive">
            Fix these before reviewing:
          </p>
          <ul className="mt-1 list-inside list-disc text-sm text-destructive">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <a
                  href={`#${issueTarget(issue).id}`}
                  className="underline underline-offset-2"
                  onClick={(event) => {
                    event.preventDefault();
                    focusIssue(issue);
                  }}
                >
                  {issue.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groupedItems.map(({ family, items: familyItems }) => {
        const showPlateCard = family.key === "bars_and_plates";
        if (familyItems.length === 0 && !showPlateCard) return null;
        return (
          <section key={family.key} aria-label={family.name} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <EquipmentFamilyIcon familyKey={family.key} className="size-6" />
              <h2 className="text-sm font-semibold">{family.name}</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {familyItems.map((item) => {
                const barIndex = barIndexByItemKey.get(item.clientKey);
                const matchedBar = barIndex == null ? undefined : bars[barIndex];
                const itemBarType = barTypeForEquipmentItem(item.type);
                const itemIdentity = item.id ?? item.draftId;
                const exactProfile = itemIdentity
                  ? loadProfiles.find((entry) => entry.equipmentItemId === itemIdentity)?.profile
                  : null;
                const edited =
                  item.id != null &&
                  (initialItemFingerprint.get(item.id) !==
                    JSON.stringify({ label: item.label, quantity: item.quantity, attrs: item.attrs }) ||
                    initialProfileFingerprint.get(item.id) !== JSON.stringify(exactProfile));
                return (
                  <button
                    key={item.clientKey}
                    type="button"
                    id={`equipment-card-${item.clientKey}`}
                    aria-label={`Edit ${item.label}`}
                    className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/60"
                    onClick={() => setEditing({ kind: "item", clientKey: item.clientKey })}
                  >
                    <EquipmentFamilyIcon
                      familyKey={familyForEquipmentType(item.type)}
                      className="size-8 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 break-words text-sm font-medium">
                          {item.label}
                        </span>
                        {item.id == null ? (
                          <Badge className="shrink-0">New</Badge>
                        ) : edited ? (
                          <Badge variant="secondary" className="shrink-0">Edited</Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {!item.label
                          .toLocaleLowerCase()
                          .includes(labelForEquipmentType(item.type).toLocaleLowerCase()) && (
                          <span>{labelForEquipmentType(item.type)} · </span>
                        )}
                        {item.quantity > 1 ? `Qty ${item.quantity}` : "Qty 1"}
                        {itemBarType && (
                          <span className="mt-0.5 block">
                            {matchedBar
                              ? `Empty bar ${matchedBar.barWeight} ${profileUnit} · collars ${matchedBar.collarWeight} ${profileUnit} total`
                              : "Weight not recorded"}
                          </span>
                        )}
                        {!itemBarType && summarizeExactEquipmentProfile(exactProfile) && (
                          <span className="mt-0.5 block">
                            {summarizeExactEquipmentProfile(exactProfile)}
                          </span>
                        )}
                      </span>
                    </span>
                    <Pencil className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                );
              })}

              {showPlateCard && (
                <button
                  type="button"
                  id="weight-plates-card"
                  aria-label="Edit weight plates"
                  className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/60"
                  onClick={() => setEditing({ kind: "plates" })}
                >
                  <EquipmentFamilyIcon familyKey="bars_and_plates" className="size-8 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">Weight plates</span>
                      {platesDirty && (
                        <Badge variant="secondary" className="shrink-0">Edited</Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {plates.length === 0
                        ? "No plates yet — tap to add sizes"
                        : `${totalPlates(plates)} plates across ${plates.length} ${
                            plates.length === 1 ? "size" : "sizes"
                          }`}
                    </span>
                  </span>
                  <Pencil className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )}
            </div>
          </section>
        );
      })}

      {removedItems.length > 0 && (
        <section aria-label="Items removed in this draft" className="rounded-xl border border-dashed p-3">
          <h2 className="text-sm font-semibold">Will be removed on save</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {removedItems.map((item) => (
              <li key={item.clientKey} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words">
                  {item.label}{" "}
                  <span className="text-muted-foreground">
                    ({labelForEquipmentType(item.type)})
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  aria-label={`Keep ${item.label}`}
                  onClick={() => restoreItem(item)}
                >
                  <Undo2 className="size-3.5" /> Keep
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unmatchedBars.length > 0 && (
        <section id="unmatched-bar-configurations" tabIndex={-1} aria-label="Unmatched saved configurations" className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 outline-none">
          <h2 className="text-sm font-semibold">Unmatched saved configuration</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            These saved values cannot be linked safely to one inventory item. They will be preserved unchanged, and weight editing is paused for them. Other inventory remains editable.
          </p>
          {ambiguousBarTypes.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Repeated configuration types: {ambiguousBarTypes.join(", ")}.
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {unmatchedBars.map((bar) => (
              <li key={bar.clientKey} className="rounded-md border bg-background/70 p-2">
                {bar.label}: empty bar {bar.barWeight} {profileUnit} · collars {bar.collarWeight} {profileUnit} total
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Item detail drawer */}
      <Sheet
        open={editing?.kind === "item"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md [&_button]:min-h-11 [&_button]:min-w-11"
        >
          {editingItem && (
            <ItemDrawerBody
              key={editingItem.clientKey}
              item={editingItem}
              matchedBar={
                (() => {
                  const barIndex = barIndexByItemKey.get(editingItem.clientKey);
                  return barIndex == null ? undefined : bars[barIndex];
                })()
              }
              ambiguousBar={(() => {
                const barType = barTypeForEquipmentItem(editingItem.type);
                return barType ? barAssociation.ambiguousTypes.includes(barType) : false;
              })()}
              definition={editingItem.id ? definitionByItem.get(editingItem.id) : undefined}
              profileUnit={profileUnit}
              profile={(() => {
                const identity = editingItem.id ?? editingItem.draftId;
                return identity
                  ? loadProfiles.find((entry) => entry.equipmentItemId === identity)?.profile ?? null
                  : null;
              })()}
              plates={plates}
              cableStations={items.flatMap((candidate) =>
                candidate.id && candidate.type === "cable"
                  ? [{ id: candidate.id, label: candidate.label }]
                  : []
              )}
              attachments={items.flatMap((candidate) =>
                candidate.id && candidate.type === "other"
                  ? [{ id: candidate.id, label: candidate.label }]
                  : []
              )}
              compatibleCableStationIds={editingItem.id ? loadProfiles.flatMap((entry) =>
                entry.profile.kind === "cable_machine" &&
                entry.profile.compatibleAttachmentItemIds.includes(editingItem.id as string)
                  ? [entry.equipmentItemId]
                  : []
              ) : []}
              onSave={(next, bar, profile, compatibleCableStationIds) => {
                commitItemEdit(next, bar, profile, compatibleCableStationIds);
                setEditing(null);
                setStagedItemMessage(`${next.label} changes are in your draft. Review and confirm to save them.`);
              }}
              onCancel={() => setEditing(null)}
              onRemove={() => {
                removeItem(editingItem);
                setEditing(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Plate pool drawer */}
      <Sheet
        open={editing?.kind === "plates"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md [&_button]:min-h-11 [&_button]:min-w-11"
        >
          {editing?.kind === "plates" && (
            <PlateDrawerBody
              plates={plates}
              unit={profileUnit}
              onSave={(next) => {
                setPlates(next);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto [&_button]:min-h-11 [&_button]:min-w-11">
          <DialogHeader>
            <DialogTitle>Add equipment</DialogTitle>
            <DialogDescription>
              Every supported equipment type is available here, including
              specialty gear.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Search equipment types"
            aria-label="Search equipment types"
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
          />
          <div className="flex flex-col gap-3">
            {pickerGroups(addQuery).map(({ family, types }) => (
              <div key={family.key}>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {family.name}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {types.map((type) => (
                    <Button
                      key={type}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => addItem(type)}
                    >
                      {labelForEquipmentType(type)}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
            {pickerGroups(addQuery).length === 0 && (
              <p className="text-sm text-muted-foreground">
                No equipment type matches that search.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelOpen}
        onOpenChange={(open) => {
          setCancelOpen(open);
          if (!open) setPendingDestination(null);
        }}
      >
        <DialogContent className="[&_button]:min-h-11 [&_button]:min-w-11">
          <DialogHeader>
            <DialogTitle>Discard unsaved equipment changes?</DialogTitle>
            <DialogDescription>
              Your edits here have not been saved. Leaving now keeps your
              inventory exactly as it was.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => {
                setCancelOpen(false);
                setPendingDestination(null);
              }}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => router.push(pendingDestination ?? cancelHref)}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        data-equipment-action-footer
        className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-30 border-t bg-background/95 p-2 backdrop-blur lg:bottom-0 lg:left-[var(--main-sidebar-width)] lg:p-3"
      >
        <div className="mx-auto flex max-w-4xl gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-w-0 flex-1 px-2"
            disabled={pending}
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-w-0 flex-[1.5] px-2"
            disabled={pending || (!dirty && !reviewNextHref)}
            onClick={() => {
              if (!dirty && reviewNextHref) router.push(reviewNextHref);
              else startReview();
            }}
          >
            {pending
              ? "Preparing review…"
              : dirty
                ? "Review changes"
                : reviewNextHref
                  ? "Continue without changes"
                  : "No changes to save"}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <p aria-live="polite" role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}

/**
 * Local-staging body for editing one equipment item (and its associated bar)
 * inside the detail drawer. Edits stay local until Save commits them to the
 * page draft, so Cancel discards cleanly.
 */
function ItemDrawerBody({
  item,
  matchedBar,
  ambiguousBar,
  definition,
  profileUnit,
  profile,
  plates,
  cableStations,
  attachments,
  compatibleCableStationIds,
  onSave,
  onCancel,
  onRemove,
}: {
  item: DraftEquipmentItem;
  matchedBar: DraftBar | undefined;
  ambiguousBar: boolean;
  definition: { label: string; description: string | null } | undefined;
  profileUnit: LoadUnit;
  profile: EquipmentLoadProfile | null;
  plates: DraftPlate[];
  cableStations: Array<{ id: string; label: string }>;
  attachments: Array<{ id: string; label: string }>;
  compatibleCableStationIds: string[];
  onSave: (
    item: DraftEquipmentItem,
    bar: DraftBar | null,
    profile: EquipmentLoadProfile | null,
    compatibleCableStationIds: string[],
  ) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [draftItem, setDraftItem] = useState<DraftEquipmentItem>(item);
  const [draftBar, setDraftBar] = useState<DraftBar | null>(matchedBar ?? null);
  const [draftProfile, setDraftProfile] = useState<EquipmentLoadProfile | null>(profile);
  const [draftCompatibleCableStationIds, setDraftCompatibleCableStationIds] = useState(
    compatibleCableStationIds,
  );
  const profileValidation = draftProfile == null ? null : equipmentLoadProfileSchema.safeParse(draftProfile);
  const profileIssues = profileValidation?.success === false ? profileValidation.error.issues : [];
  const profileIssueId = `equipment-${draftItem.clientKey}-profile-issues`;
  const itemBarType = barTypeForEquipmentItem(draftItem.type);
  const isHandheld =
    draftItem.type === "dumbbell" || draftItem.type === "kettlebell";
  const handheldSetupIssue = (() => {
    if (!isHandheld) return null;
    const hasStartedHandheldSetup =
      typeof draftItem.attrs.adjustable === "boolean" ||
      typeof draftItem.attrs.pair === "boolean";
    if (
      hasStartedHandheldSetup &&
      (typeof draftItem.attrs.adjustable !== "boolean" ||
        typeof draftItem.attrs.pair !== "boolean")
    ) {
      return "Choose Adjustable or Fixed weights and Pair or Single before saving.";
    }
    const fixedWeightStatus = fixedHandheldWeightStatus({
      type: draftItem.type,
      adjustable: draftItem.attrs.adjustable,
      increments: draftItem.attrs.increments,
      minWeight: draftItem.attrs.minWeight,
      maxWeight: draftItem.attrs.maxWeight,
    });
    if (fixedWeightStatus === "missing") {
      return "Select at least one owned weight before saving fixed equipment.";
    }
    if (fixedWeightStatus === "inconsistent") {
      return "Confirm the exact owned weights before saving fixed equipment.";
    }
    return null;
  })();
  const handheldSetupIssueId = `equipment-${draftItem.clientKey}-setup-issue`;

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>{draftItem.label || labelForEquipmentType(draftItem.type)}</SheetTitle>
        <SheetDescription>
          {labelForEquipmentType(draftItem.type)}
          {item.id == null ? " · new item" : ""}
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {definition && (
          <p className="mb-3 text-xs text-muted-foreground">
            Specific type: {definition.label}
            {definition.description ? ` — ${definition.description}` : ""}
          </p>
        )}
        <EquipmentItemEditor
          item={draftItem}
          profileUnit={profileUnit}
          onChange={setDraftItem}
        />
        {handheldSetupIssue && (
          <p
            id={handheldSetupIssueId}
            className="mt-3 rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 text-xs leading-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
          >
            {handheldSetupIssue}
          </p>
        )}
        {profileIssues.length > 0 && (
          <div id={profileIssueId} role="alert" className="my-3 rounded-lg border border-destructive/40 p-3 text-sm">
            <p className="font-medium">Complete these fields before saving:</p>
            <ul className="list-inside list-disc">{profileIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
          </div>
        )}
        {["machine", "smith_machine", "cable"].includes(draftItem.type) && (
          <MachineLoadingMethodEditor
            item={draftItem}
            profile={draftProfile}
            onChange={(next) => {
              setDraftItem((current) => ({ ...current, type: next.type, attrs: {
                ...current.attrs,
                ...(next.cablePulley === undefined ? {} : { cablePulley: next.cablePulley }),
              } }));
              setDraftProfile(next.profile);
            }}
          />
        )}
        {draftProfile?.kind === "plate_loaded_machine" && (
          <label className="my-2 flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={draftItem.attrs.cablePulley === true}
              onChange={(event) => setDraftItem((current) => ({ ...current,
                attrs: { ...current.attrs, cablePulley: event.target.checked },
              }))} />
            This machine also provides a cable pulley for cable exercises
          </label>
        )}
        {canEditExactEquipmentProfile(draftItem) ? (
          <EquipmentLoadProfileEditor
            item={draftItem}
            profile={draftProfile}
            profileUnit={profileUnit}
            plates={plates}
            cableStations={cableStations}
            attachments={attachments}
            onChange={(nextProfile) => {
              setDraftProfile(nextProfile);
              if (draftItem.type === "other" && nextProfile == null) {
                setDraftCompatibleCableStationIds([]);
              }
            }}
            compatibleCableStationIds={draftCompatibleCableStationIds}
            onCompatibleCableStationIdsChange={setDraftCompatibleCableStationIds}
          />
        ) : (
          <p className="mt-4 rounded-lg border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
            Save this physical item first. Then reopen it to record its exact loading setup without guessing which saved item the setup belongs to.
          </p>
        )}
        {itemBarType && (
          <div className="mt-4 border-t pt-4">
            {draftBar ? (
              <BarWeightEditor
                bar={draftBar}
                unit={profileUnit}
                onChange={setDraftBar}
              />
            ) : (
              <MissingBarWeightEditor
                barType={itemBarType}
                unit={profileUnit}
                ambiguous={ambiguousBar}
                onCreate={(weight) =>
                  setDraftBar({
                    clientKey: crypto.randomUUID(),
                    id: null,
                    barType: itemBarType,
                    barWeight: weight,
                    collarWeight: 0,
                    quantity: draftItem.quantity,
                    label: draftItem.label,
                  })
                }
              />
            )}
          </div>
        )}
        <div className="mt-4 border-t pt-4">
          <RemoveItemButton label={item.label} onRemove={onRemove} />
        </div>
      </div>

      <SheetFooter className="flex-row border-t">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-0 flex-1 whitespace-normal py-2"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-auto min-h-11 min-w-0 flex-1 whitespace-normal py-2"
          disabled={handheldSetupIssue != null || profileIssues.length > 0}
          aria-describedby={profileIssues.length ? profileIssueId : handheldSetupIssue ? handheldSetupIssueId : undefined}
          onClick={() =>
            onSave(
              { ...draftItem, label: draftItem.label },
              draftBar,
              draftProfile,
              draftCompatibleCableStationIds,
            )
          }
        >
          Use changes in draft
        </Button>
      </SheetFooter>
    </>
  );
}

/** Local-staging body for editing the shared plate pool inside the drawer. */
function PlateDrawerBody({
  plates,
  unit,
  onSave,
  onCancel,
}: {
  plates: DraftPlate[];
  unit: LoadUnit;
  onSave: (plates: DraftPlate[]) => void;
  onCancel: () => void;
}) {
  const [draftPlates, setDraftPlates] = useState<DraftPlate[]>(plates);
  const spareCount = draftPlates.filter((plate) => hasSparePlate(plate.quantity)).length;

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>Weight plates</SheetTitle>
        <SheetDescription>
          One shared pool. Add each size with the total number of plates you
          own — single plates are fine.
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <PlateInventoryEditor
          plates={draftPlates}
          unit={unit}
          onChange={setDraftPlates}
        />
        {spareCount > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {spareCount === 1 ? "One size has" : `${spareCount} sizes have`} a
            spare plate that can’t be loaded as a symmetric pair.
          </p>
        )}
      </div>

      <SheetFooter className="flex-row border-t">
        <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" className="flex-1" onClick={() => onSave(draftPlates)}>
          Save changes
        </Button>
      </SheetFooter>
    </>
  );
}

function BarWeightEditor({
  bar,
  unit,
  onChange,
}: {
  bar: DraftBar;
  unit: LoadUnit;
  onChange: (bar: DraftBar) => void;
}) {
  const suggestions = COMMON_BAR_WEIGHTS[bar.barType][unit];
  return (
    <div>
      <p className="text-sm font-medium">Bar load details</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {suggestions.map((weight) => (
          <button
            key={weight}
            type="button"
            aria-pressed={bar.barWeight === weight}
            onClick={() => onChange({ ...bar, barWeight: weight })}
            className={cn(
              "min-h-11 rounded-full border px-3 py-1 text-xs tabular-nums",
              bar.barWeight === weight
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background"
            )}
          >
            {weight} {unit}
          </button>
        ))}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <span className="flex items-center gap-1.5">
          <label
            htmlFor={`bar-weight-${bar.clientKey}`}
            className="text-xs text-muted-foreground"
          >
            Empty bar weight
          </label>
          <Input
            id={`bar-weight-${bar.clientKey}`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.25"
            value={bar.barWeight}
            className="h-11 w-24 text-sm"
            onChange={(event) => {
              const weight = Number(event.target.value);
              if (Number.isFinite(weight)) onChange({ ...bar, barWeight: weight });
            }}
          />
          <span className="text-xs text-muted-foreground">{unit}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <label
            htmlFor={`collar-weight-${bar.clientKey}`}
            className="text-xs text-muted-foreground"
          >
            Both collars, total
          </label>
          <Input
            id={`collar-weight-${bar.clientKey}`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.25"
            value={bar.collarWeight}
            className="h-11 w-24 text-sm"
            onChange={(event) => {
              const weight = Number(event.target.value);
              if (Number.isFinite(weight) && weight >= 0) {
                onChange({ ...bar, collarWeight: weight });
              }
            }}
          />
          <span className="text-xs text-muted-foreground">{unit}</span>
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Enter the bar by itself, before plates. Workout totals include this weight, both collars, and the plates loaded on both sides.
      </p>
    </div>
  );
}

function MissingBarWeightEditor({
  barType,
  unit,
  ambiguous,
  onCreate,
}: {
  barType: "olympic" | "ez";
  unit: LoadUnit;
  ambiguous: boolean;
  onCreate: (weight: number) => void;
}) {
  const [value, setValue] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  if (ambiguous) {
    return (
      <div className="rounded-md border border-amber-500/60 bg-amber-500/10 p-2">
        <p className="text-sm font-medium">Weight not recorded</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Repeated bars cannot be assigned different weights in Release A. The unmatched saved configuration below stays unchanged.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed p-2">
      <p className="text-sm font-medium">Weight not recorded</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Choose or enter the empty bar weight. Suggestions are never selected automatically.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {COMMON_BAR_WEIGHTS[barType][unit].map((weight) => (
          <Button key={weight} type="button" variant="outline" size="sm" onClick={() => onCreate(weight)}>
            {weight} {unit}
          </Button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <label htmlFor={`missing-bar-weight-${barType}`} className="text-xs text-muted-foreground">
          Empty bar weight
        </label>
        <Input
          id={`missing-bar-weight-${barType}`}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.25"
          value={value}
          className="h-11 w-24 text-sm"
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const weight = Number(value);
            if (!Number.isFinite(weight) || weight <= 0) {
              return setCustomError("Enter an empty bar weight above zero.");
            }
            if (weight > MAX_STORED_LOAD) {
              return setCustomError("That bar weight is beyond the supported range.");
            }
            if (Math.round(weight * 100) !== weight * 100) {
              return setCustomError("Bar weights support at most two decimal places.");
            }
            setCustomError(null);
            onCreate(weight);
          }}
        >
          Record weight
        </Button>
        {customError && <span role="alert" className="basis-full text-xs text-destructive">{customError}</span>}
      </div>
    </div>
  );
}
