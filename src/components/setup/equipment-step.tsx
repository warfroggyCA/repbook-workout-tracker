"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  parseSetupEquipment,
  confirmSetupEquipment,
  saveEquipmentChecklist,
  type EquipmentParseResponse,
} from "@/app/actions/setup";
import {
  amberFields,
  AMBER_QUESTIONS,
  type AmberField,
  type ConfirmedEquipmentItem,
} from "@/ai/tasks/equipment-parse/confirm";
import {
  expandRackLikeSupportItems,
  normalizeParsedEquipmentItem,
} from "@/ai/tasks/equipment-parse/normalize";
import {
  COMMON_BAR_WEIGHTS,
  COMMON_FIXED_WEIGHTS,
} from "@/lib/equipment-inventory-contract";
import { labelForEquipmentType } from "@/lib/equipment-families";
import {
  checklistFromExisting,
  type DraftChecklistItem,
  type SetupExistingInventory,
} from "@/lib/setup-equipment-checklist";
import { PlateInventoryEditor } from "@/components/equipment/plate-inventory-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Minus, Plus, X } from "lucide-react";

type Unit = "lb" | "kg";
type Denom = { id?: string; weight: number; quantity: number };

const WEIGHTED_ENTRY_TYPES = new Set<ConfirmedEquipmentItem["type"]>([
  "barbell",
  "ez_bar",
  "plates",
  "dumbbell",
  "kettlebell",
]);

function emptyItem(
  type: ConfirmedEquipmentItem["type"],
  label: string
): ConfirmedEquipmentItem {
  return {
    type,
    label,
    quantity: 1,
    minWeight: null,
    maxWeight: null,
    unit: null,
    adjustable: null,
    pair: null,
    increments: null,
    denominations: null,
    brand: null,
    barWeight: null,
    adjustableBench: null,
  };
}

// ---------------------------------------------------------------------------
// Small shared editors
// ---------------------------------------------------------------------------

function ChoicePills<T extends string | boolean>({
  value,
  options,
  onChange,
}: {
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "min-h-11 min-w-11 rounded-full border px-2.5 py-1 text-xs transition-colors",
            value === opt.value
              ? "border-primary bg-primary text-primary-foreground"
              : "bg-background"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      value={value ?? ""}
      placeholder={placeholder}
      className={cn("h-11 text-sm", className)}
      aria-label={ariaLabel}
      onChange={(e) => {
        const n = e.target.value === "" ? null : Number(e.target.value);
        onChange(n != null && Number.isFinite(n) ? n : null);
      }}
    />
  );
}

function QuantityStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const set = (n: number) => onChange(Math.min(99, Math.max(1, n)));
  return (
    <div className="flex items-center gap-2 px-2 text-sm">
      <span className="text-xs text-muted-foreground">How many</span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-11"
          aria-label="Decrease quantity"
          disabled={value <= 1}
          onClick={() => set(value - 1)}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-6 text-center font-medium tabular-nums">{value}</span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="size-11"
          aria-label="Increase quantity"
          onClick={() => set(value + 1)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function DenominationsEditor({
  denoms,
  unit,
  onChange,
}: {
  denoms: Denom[];
  unit: Unit | null;
  onChange: (d: Denom[]) => void;
}) {
  if (!unit) {
    return (
      <p className="text-xs text-muted-foreground">
        Choose pounds or kilograms before selecting plate sizes.
      </p>
    );
  }
  return (
    <PlateInventoryEditor
      unit={unit}
      plates={denoms.map((denomination) => ({
        clientKey: denomination.id ?? `plate-${denomination.weight}`,
        id: denomination.id ?? null,
        denomination: denomination.weight,
        quantity: denomination.quantity,
      }))}
      onChange={(plates) =>
        onChange(
          plates.map((plate) => ({
            id: plate.id ?? undefined,
            weight: plate.denomination,
            quantity: plate.quantity,
          }))
        )
      }
    />
  );
}

function AvailableWeightsEditor({
  item,
  onChange,
}: {
  item: ConfirmedEquipmentItem;
  onChange: (item: ConfirmedEquipmentItem) => void;
}) {
  const [custom, setCustom] = useState<number | null>(null);
  if (!item.unit || (item.type !== "dumbbell" && item.type !== "kettlebell")) {
    return null;
  }
  const selected = item.increments ?? [];
  const choices = [...new Set([...COMMON_FIXED_WEIGHTS[item.type][item.unit], ...selected])]
    .sort((left, right) => left - right);
  const apply = (weights: number[]) => {
    const sorted = [...new Set(weights)].sort((left, right) => left - right);
    onChange({
      ...item,
      increments: sorted.length ? sorted : null,
      minWeight: sorted[0] ?? item.minWeight,
      maxWeight: sorted[sorted.length - 1] ?? item.maxWeight,
    });
  };
  return (
    <div className="flex flex-col gap-2 px-2">
      <p className="text-xs text-muted-foreground">
        Available weights ({item.unit}) — select every load you can use
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Available ${item.type} weights`}>
        {choices.map((weight) => (
          <button
            key={weight}
            type="button"
            aria-pressed={selected.includes(weight)}
            className={cn(
              "min-h-11 min-w-11 rounded-full border px-3 py-1 text-xs tabular-nums",
              selected.includes(weight)
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-background"
            )}
            onClick={() =>
              apply(
                selected.includes(weight)
                  ? selected.filter((value) => value !== weight)
                  : [...selected, weight]
              )
            }
          >
            {weight}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NumberInput value={custom} onChange={setCustom} placeholder="custom" className="w-24" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={custom == null || custom <= 0 || selected.includes(custom)}
          onClick={() => {
            if (custom != null && custom > 0) {
              apply([...selected, custom]);
              setCustom(null);
            }
          }}
        >
          Add custom {item.unit}
        </Button>
      </div>
    </div>
  );
}

/** Amber wrapper: highlighted while the field is unresolved. */
function AmberField({
  active,
  question,
  children,
}: {
  active: boolean;
  question: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md p-2",
        active && "border border-amber-500/70 bg-amber-500/10"
      )}
    >
      <p
        className={cn(
          "mb-1 text-xs",
          active
            ? "font-medium text-amber-700 dark:text-amber-400"
            : "text-muted-foreground"
        )}
      >
        {question}
      </p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item editor card (shared by AI-confirm and checklist detail views)
// ---------------------------------------------------------------------------

function ItemEditor({
  item,
  questions,
  onChange,
}: {
  item: ConfirmedEquipmentItem;
  /** AI ambiguity text per field, when the model asked something specific. */
  questions?: Partial<Record<string, string>>;
  onChange: (item: ConfirmedEquipmentItem) => void;
}) {
  const ambers = new Set<AmberField>(amberFields(item));
  const q = (field: AmberField) => questions?.[field] ?? AMBER_QUESTIONS[field];

  function setUnit(unit: Unit) {
    onChange({ ...item, unit });
  }

  const showsUnit = WEIGHTED_ENTRY_TYPES.has(item.type);
  const showsWeights = item.type === "dumbbell" || item.type === "kettlebell";

  return (
    <div className="flex flex-col gap-2">
      {item.type !== "plates" && (
        <QuantityStepper
          value={item.quantity}
          onChange={(v) => onChange({ ...item, quantity: v })}
        />
      )}

      {showsUnit && (
        <AmberField active={ambers.has("unit")} question={q("unit")}>
          <ChoicePills
            value={item.unit}
            options={[
              { value: "lb" as const, label: "lb" },
              { value: "kg" as const, label: "kg" },
            ]}
            onChange={setUnit}
          />
        </AmberField>
      )}

      {showsWeights && (
        <div className="flex items-center gap-2 px-2 text-sm">
          <span className="text-xs text-muted-foreground">Range</span>
          <NumberInput
            value={item.minWeight}
            onChange={(v) => onChange({ ...item, minWeight: v })}
            placeholder="min"
            className="w-20"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <NumberInput
            value={item.maxWeight}
            onChange={(v) => onChange({ ...item, maxWeight: v })}
            placeholder="max"
            className="w-20"
          />
          <span className="text-xs text-muted-foreground">{item.unit ?? ""}</span>
        </div>
      )}

      {showsWeights && <AvailableWeightsEditor item={item} onChange={onChange} />}

      {(item.type === "dumbbell" || item.type === "kettlebell") && (
        <AmberField active={ambers.has("adjustable")} question={q("adjustable")}>
          <ChoicePills
            value={item.adjustable}
            options={[
              { value: true, label: "Adjustable" },
              { value: false, label: "Fixed" },
            ]}
            onChange={(v) => onChange({ ...item, adjustable: v })}
          />
        </AmberField>
      )}

      {(item.type === "dumbbell" || item.type === "kettlebell") && (
        <AmberField active={ambers.has("pair")} question={q("pair")}>
          <ChoicePills
            value={item.pair}
            options={[
              { value: true, label: "Pair" },
              { value: false, label: "Single" },
            ]}
            onChange={(v) => onChange({ ...item, pair: v })}
          />
        </AmberField>
      )}

      {item.type === "plates" && (
        <AmberField
          active={ambers.has("denominations")}
          question={q("denominations")}
        >
          <DenominationsEditor
            denoms={item.denominations ?? []}
            unit={item.unit}
            onChange={(d) =>
              onChange({ ...item, denominations: d.length ? d : null })
            }
          />
        </AmberField>
      )}

      {(item.type === "barbell" || item.type === "ez_bar") && item.unit != null && (
        <AmberField active={ambers.has("barWeight")} question={q("barWeight")}>
          <div className="flex flex-col gap-2 text-sm">
            {item.statedBarUnit && item.statedBarWeight != null && (
              <div className="rounded-md border border-amber-500/60 bg-amber-500/10 p-2 text-xs">
                <p>
                  Stated: {item.statedBarWeight} {item.statedBarUnit}. Converted to your account unit: {item.barWeight} {item.unit}.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 min-h-11"
                  aria-pressed={item.barWeightConfirmed === true}
                  onClick={() => onChange({ ...item, barWeightConfirmed: true })}
                >
                  Confirm converted weight
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
            {COMMON_BAR_WEIGHTS[item.type === "barbell" ? "olympic" : "ez"][item.unit].map((weight) => (
              <button
                key={weight}
                type="button"
                aria-pressed={item.barWeight === weight}
                className={cn(
                  "min-h-11 min-w-11 rounded-full border px-3 py-1 text-xs",
                  item.barWeight === weight
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background"
                )}
                onClick={() => onChange({ ...item, barWeight: weight })}
              >
                {weight} {item.unit}
              </button>
            ))}
            <span className="text-xs text-muted-foreground">Empty bar weight</span>
            <NumberInput
              value={item.barWeight}
              onChange={(v) => onChange({ ...item, barWeight: v })}
              className="w-20"
              ariaLabel="Empty bar weight"
            />
            <span className="text-xs text-muted-foreground">{item.unit}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Both collars, total</span>
              <NumberInput
                value={item.collarWeight ?? 0}
                onChange={(v) => onChange({ ...item, collarWeight: v ?? 0 })}
                className="w-20"
                ariaLabel="Both collars, total"
              />
              <span className="text-xs text-muted-foreground">{item.unit}</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Enter the bar by itself, before plates. Workout totals include this weight, both collars, and the plates loaded on both sides.
            </p>
          </div>
        </AmberField>
      )}

      {item.type === "trap_bar" && item.barWeight != null && (
        <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          Stated trap/hex bar weight: {item.barWeight} {item.unit ?? "(unit not stated)"}. Release A keeps this as unresolved context and does not use it for plate calculations.
        </div>
      )}

      {item.type === "bench" && (
        <div className="px-2">
          <ChoicePills
            value={item.adjustableBench}
            options={[
              { value: false, label: "Flat" },
              { value: true, label: "Adjustable" },
            ]}
            onChange={(v) => onChange({ ...item, adjustableBench: v })}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI parse → confirmation flow
// ---------------------------------------------------------------------------

type ParseOk = Extract<EquipmentParseResponse, { ok: true }>;

function DescribeTab({ profileUnit }: { profileUnit: Unit }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<ParseOk | null>(null);
  const [items, setItems] = useState<ConfirmedEquipmentItem[]>([]);
  const [discarded, setDiscarded] = useState<number[]>([]);
  const [itemQuestions, setItemQuestions] = useState<
    Record<number, Partial<Record<string, string>>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleParse() {
    setError(null);
    startTransition(async () => {
      const result = await parseSetupEquipment(input);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setParsed(result);
      const normalizedItems = expandRackLikeSupportItems(
        result.envelope.data.items.map((item) =>
          normalizeParsedEquipmentItem(item, profileUnit)
        )
      );
      setItems(normalizedItems);
      // Attach the model's own questions to the fields they reference.
      const byItem: Record<number, Partial<Record<string, string>>> = {};
      for (const amb of result.envelope.ambiguities) {
        const m = amb.field.match(/items\[(\d+)\][^a-z]*(?:attrs\.)?(\w+)?/i);
        if (!m) continue;
        const idx = Number(m[1]);
        const field = m[2] ?? "";
        if (!amberFields(normalizedItems[idx]).includes(field as AmberField)) {
          continue;
        }
        byItem[idx] = { ...byItem[idx], [field]: amb.issue };
      }
      setItemQuestions(byItem);
      setDiscarded([]);
    });
  }

  const kept = items.filter((_, i) => !discarded.includes(i));
  const unresolvedCount = kept.reduce(
    (n, item) => n + amberFields(item).length,
    0
  );

  function handleSave() {
    if (!parsed) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmSetupEquipment({
        parsingEventId: parsed.parsingEventId,
        items: kept,
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push("/setup/constraints");
    });
  }

  if (!parsed) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          placeholder={
            'e.g. "bench press station, Olympic bar, EZ bar, dumbbells up to 35, plates, adjustable kettlebell, Bodylastics bands, skipping rope, elliptical"'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Describe everything in your own words. You&apos;ll review and confirm
          each item before anything is saved.
        </p>
        {error && (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}
        <Button disabled={pending || !input.trim()} onClick={handleParse}>
          {pending ? "Parsing…" : "Parse my equipment"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Confirm before saving</p>
        <Badge variant="outline">parsed by AI</Badge>
      </div>

      {unresolvedCount > 0 && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Review the highlighted fields below. Everything else can be edited
          before saving.
        </p>
      )}

      {items.map((item, idx) => {
        const isDiscarded = discarded.includes(idx);
        const ambers = amberFields(item);
        return (
          <div
            key={idx}
            className={cn(
              "rounded-xl border p-2",
              isDiscarded && "opacity-40",
              !isDiscarded && ambers.length > 0 && "border-amber-500/70"
            )}
          >
            <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-1">
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  value={item.label}
                  className="h-8 text-sm font-medium"
                  onChange={(e) =>
                    setItems((arr) =>
                      arr.map((x, j) =>
                        j === idx ? { ...x, label: e.target.value } : x
                      )
                    )
                  }
                />
                <Badge variant="outline" className="shrink-0">
                  {item.type.replace("_", " ")}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={isDiscarded ? "Keep item" : "Discard item"}
                onClick={() =>
                  setDiscarded((d) =>
                    d.includes(idx) ? d.filter((i) => i !== idx) : [...d, idx]
                  )
                }
              >
                {isDiscarded ? <Plus className="size-3.5" /> : <X className="size-3.5" />}
              </Button>
            </div>
            {!isDiscarded && (
              <ItemEditor
                item={item}
                questions={itemQuestions[idx]}
                onChange={(next) =>
                  setItems((arr) => arr.map((x, j) => (j === idx ? next : x)))
                }
              />
            )}
          </div>
        );
      })}

      {parsed.envelope.unparsed.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t place: {parsed.envelope.unparsed.join(" · ")}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {unresolvedCount > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {unresolvedCount} highlighted field{unresolvedCount > 1 ? "s" : ""} to
          confirm before saving.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={pending || kept.length === 0 || unresolvedCount > 0}
          onClick={handleSave}
        >
          {pending ? "Saving…" : "Save equipment"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setParsed(null);
            setItems([]);
            setError(null);
          }}
        >
          Edit text
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklist path
// ---------------------------------------------------------------------------

const CHECKLIST: Array<{
  type: ConfirmedEquipmentItem["type"];
  label: string;
}> = [
  { type: "rack", label: "Rack-like support / stands" },
  { type: "bench", label: "Bench" },
  { type: "barbell", label: "Olympic barbell" },
  { type: "ez_bar", label: "EZ bar" },
  { type: "plates", label: "Weight plates" },
  { type: "dumbbell", label: "Dumbbells" },
  { type: "kettlebell", label: "Kettlebell" },
  { type: "bands", label: "Resistance bands" },
  { type: "pullup_bar", label: "Pull-up bar" },
  { type: "jump_rope", label: "Jump rope" },
  { type: "elliptical", label: "Elliptical" },
  { type: "cable", label: "Cable machine" },
];

function ChecklistTab({
  profileUnit,
  existing,
}: {
  profileUnit: Unit;
  existing: SetupExistingInventory;
}) {
  const router = useRouter();
  const initialDraft = useMemo(
    () => checklistFromExisting(existing, profileUnit),
    [existing, profileUnit]
  );
  const hiddenCompatibilityItems = useMemo(
    () => {
      const firstPlateIndex = initialDraft.findIndex(
        (item) => item.type === "plates"
      );
      return initialDraft
        .filter((item, index) => {
          if (item.type === "bodyweight") return true;
          if (item.type !== "plates") return false;
          return index !== firstPlateIndex;
        })
        .map((item) =>
          item.type === "plates" ? { ...item, denominations: [] } : item
        );
    },
    [initialDraft]
  );
  const [draftItems, setDraftItems] = useState<DraftChecklistItem[]>(
    () => {
      const firstPlateIndex = initialDraft.findIndex(
        (item) => item.type === "plates"
      );
      return initialDraft.filter((item, index) => {
        if (item.type === "bodyweight") return false;
        if (item.type !== "plates") return true;
        return index === firstPlateIndex;
      });
    }
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function addItem(type: ConfirmedEquipmentItem["type"], label: string) {
    const item = emptyItem(type, label);
    item.unit = WEIGHTED_ENTRY_TYPES.has(type) ? profileUnit : null;
    if (type === "dumbbell") {
      item.adjustable = false;
      item.pair = true;
    }
    if (type === "kettlebell") item.adjustable = false;
    if (type === "bench") item.adjustableBench = false;
    // Plates and bar weights deliberately start unselected: the common values
    // are choices, never ownership assumptions (UI-006).
    setDraftItems((current) => [
      ...current,
      { ...item, clientKey: crypto.randomUUID() },
    ]);
  }

  function updateItem(next: DraftChecklistItem) {
    setDraftItems((current) =>
      current.map((item) => (item.clientKey === next.clientKey ? next : item))
    );
  }

  const items = [...hiddenCompatibilityItems, ...draftItems].map(({ clientKey, ...item }) => {
    void clientKey;
    return item;
  });
  const unresolvedCount = items.reduce(
    (n, item) => n + amberFields(item).length,
    0
  );

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveEquipmentChecklist({ items });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push("/setup/constraints");
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {CHECKLIST.map(({ type, label }) => {
        const matchingItems = draftItems.filter((item) => item.type === type);
        return (
          <section
            key={type}
            className={cn("rounded-xl border p-2", matchingItems.length && "border-primary/40")}
            aria-label={label}
          >
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-medium">{label}</h3>
              {(type !== "plates" || matchingItems.length === 0) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => addItem(type, label)}
                >
                  <Plus className="size-3.5" />
                  {matchingItems.length ? "Add another" : "Add"}
                </Button>
              )}
            </div>
            {matchingItems.length === 0 ? (
              <p className="px-1 pb-1 text-xs text-muted-foreground">Not selected</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {matchingItems.map((item) => (
                  <ChecklistItemCard
                    key={item.clientKey}
                    item={item}
                    onChange={updateItem}
                    onRemove={() =>
                      setDraftItems((current) =>
                        current.filter((row) => row.clientKey !== item.clientKey)
                      )
                    }
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {draftItems.some(
        (item) => !CHECKLIST.some((entry) => entry.type === item.type)
      ) && (
        <section className="rounded-xl border p-2" aria-label="Other saved equipment">
          <h3 className="px-1 text-sm font-medium">Other saved equipment</h3>
          <p className="px-1 text-xs text-muted-foreground">
            Specialty items saved earlier stay here individually and are kept
            unless you explicitly remove them.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {draftItems
              .filter((item) => !CHECKLIST.some((entry) => entry.type === item.type))
              .map((item) => (
                <ChecklistItemCard
                  key={item.clientKey}
                  item={item}
                  onChange={updateItem}
                  onRemove={() =>
                    setDraftItems((current) =>
                      current.filter((row) => row.clientKey !== item.clientKey)
                    )
                  }
                />
              ))}
          </div>
        </section>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <Button
        size="lg"
        className="mt-1"
        disabled={pending || unresolvedCount > 0}
        onClick={handleSave}
      >
        {pending ? "Saving…" : "Save & continue"}
      </Button>
    </div>
  );
}

function ChecklistItemCard({
  item,
  onChange,
  onRemove,
}: {
  item: DraftChecklistItem;
  onChange: (item: DraftChecklistItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Name for ${labelForEquipmentType(item.type)}`}
          value={item.label}
          className="h-11 min-w-0 flex-1 text-sm font-medium"
          onChange={(event) => onChange({ ...item, label: event.target.value })}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          aria-label={`Remove ${item.label}`}
          onClick={onRemove}
        >
          <X className="size-3.5" /> Remove
        </Button>
      </div>
      <ItemEditor item={item} onChange={(next) => onChange({ ...next, clientKey: item.clientKey })} />
      {item.type === "bands" && (
        <div className="px-2 pt-1">
          <Input
            placeholder="Brand (optional)"
            aria-label={`Brand for ${item.label}`}
            className="h-11 text-sm"
            value={item.brand ?? ""}
            onChange={(event) =>
              onChange({ ...item, brand: event.target.value || null })
            }
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function EquipmentStep({
  profileUnit,
  aiAvailable,
  existing,
}: {
  profileUnit: Unit;
  aiAvailable: boolean;
  existing: SetupExistingInventory;
}) {
  return (
    <Tabs defaultValue="checklist">
      <TabsList className="w-full">
        <TabsTrigger value="checklist" className="flex-1">
          Checklist
        </TabsTrigger>
        <TabsTrigger value="describe" className="flex-1">
          Describe it
        </TabsTrigger>
      </TabsList>
      <TabsContent value="checklist" className="pt-3">
        <ChecklistTab profileUnit={profileUnit} existing={existing} />
      </TabsContent>
      <TabsContent value="describe" className="pt-3">
        {aiAvailable ? (
          <DescribeTab profileUnit={profileUnit} />
        ) : (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
            AI parsing isn&apos;t configured (no ANTHROPIC_API_KEY). The
            checklist covers the same ground.
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
