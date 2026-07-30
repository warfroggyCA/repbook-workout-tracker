"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Minus, Plus, X } from "lucide-react";
import {
  COMMON_FIXED_WEIGHTS,
  equipmentFieldApplicability,
  type EquipmentInventoryItem,
} from "@/lib/equipment-inventory-contract";
import type { LoadUnit } from "@/lib/units";

export type DraftEquipmentItem = EquipmentInventoryItem & { clientKey: string };

function quantityNoun(item: DraftEquipmentItem) {
  if (item.type === "barbell" || item.type === "ez_bar") return "bars";
  if (item.type === "dumbbell" && item.attrs.pair === true) return "pairs";
  if (item.type === "dumbbell" || item.type === "kettlebell") return "singles";
  return "items";
}

function ChoicePills<T extends string | boolean>({
  value,
  options,
  onChange,
  groupLabel,
}: {
  value: T | null | undefined;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  groupLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={groupLabel}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "min-h-11 rounded-full border px-3 py-1 text-xs transition-colors",
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

function NumberField({
  id,
  label,
  value,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          value={value ?? ""}
          className="h-11 w-full min-w-0 text-sm"
          onChange={(event) => {
            const raw = event.target.value;
            const parsed = raw === "" ? null : Number(raw);
            onChange(parsed != null && Number.isFinite(parsed) ? parsed : null);
          }}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function setAttr(
  item: DraftEquipmentItem,
  key: string,
  value: unknown
): DraftEquipmentItem {
  const attrs = { ...item.attrs } as Record<string, unknown>;
  if (value == null) delete attrs[key];
  else attrs[key] = value;
  return { ...item, attrs };
}

function ownedWeightsEditor(
  item: DraftEquipmentItem,
  unit: LoadUnit,
  onChange: (item: DraftEquipmentItem) => void,
  idPrefix: string,
  description: string
) {
  const type = item.type === "kettlebell" ? "kettlebell" : "dumbbell";
  const owned = [...((item.attrs.increments as number[] | undefined) ?? [])];
  const commonChoices = COMMON_FIXED_WEIGHTS[type][unit];
  const applyOwned = (weights: number[]) => {
    const sorted = [...new Set(weights)].sort((a, b) => a - b);
    let next = setAttr(item, "increments", sorted.length ? sorted : null);
    next = setAttr(next, "minWeight", sorted.length ? sorted[0] : null);
    next = setAttr(next, "maxWeight", sorted.length ? sorted[sorted.length - 1] : null);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {description} ({unit}) — select every load you can use
      </p>
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={`Owned ${type} weights for ${item.label}`}
      >
        {[...new Set([...commonChoices, ...owned])]
          .sort((a, b) => a - b)
          .map((weight) => {
            const selected = owned.includes(weight);
            return (
              <button
                key={weight}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  applyOwned(
                    selected
                      ? owned.filter((value) => value !== weight)
                      : [...owned, weight]
                  )
                }
                className={cn(
                  "min-h-11 rounded-full border px-3 py-1 text-xs tabular-nums",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background"
                )}
              >
                {weight}
              </button>
            );
          })}
      </div>
      <CustomWeightAdd
        idPrefix={idPrefix}
        unit={unit}
        existing={owned}
        onAdd={(weight) => applyOwned([...owned, weight])}
      />
    </div>
  );
}

function CustomWeightAdd({
  idPrefix,
  unit,
  existing,
  onAdd,
}: {
  idPrefix: string;
  unit: LoadUnit;
  existing: number[];
  onAdd: (weight: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem(
          `${idPrefix}-custom-weight`
        ) as HTMLInputElement | null;
        const weight = Number(input?.value);
        if (
          !input ||
          !Number.isFinite(weight) ||
          weight <= 0
        ) return setError("Enter a weight above zero.");
        if (Math.round(weight * 100) !== weight * 100) {
          return setError("Weights support at most two decimal places.");
        }
        if (existing.includes(weight)) {
          return setError(`${weight} ${unit} is already selected.`);
        }
        setError(null);
        onAdd(weight);
        input.value = "";
      }}
    >
      <label
        htmlFor={`${idPrefix}-custom-weight`}
        className="text-xs text-muted-foreground"
      >
        Custom weight
      </label>
      <Input
        id={`${idPrefix}-custom-weight`}
        name={`${idPrefix}-custom-weight`}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.25"
        className="h-11 w-24 text-sm"
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
      <Button type="submit" variant="outline" size="sm" className="min-h-11">
        <Plus className="size-3.5" /> Add
      </Button>
      {error && (
        <span className="basis-full text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/**
 * Type-aware equipment item fields (UI-002): weight-related controls appear
 * only where a weight is meaningful for the equipment type. Server-owned
 * details such as saved levels and notes are shown but not editable here, so
 * they can never be lost by this editor.
 */
export function EquipmentItemEditor({
  item,
  profileUnit,
  onChange,
}: {
  item: DraftEquipmentItem;
  profileUnit: LoadUnit;
  onChange: (item: DraftEquipmentItem) => void;
}) {
  const applicability = equipmentFieldApplicability(item.type);
  const idPrefix = `equipment-${item.clientKey}`;
  // Existing rows keep their stored unit meaning; new weighted rows record
  // the account unit. There is deliberately no unit toggle in this release.
  const displayUnit = (item.attrs.unit as LoadUnit | undefined) ?? profileUnit;
  const adjustable = item.attrs.adjustable as boolean | undefined;
  const levels = item.attrs.levels as string[] | undefined;
  const notes = item.attrs.notes as string | undefined;

  function change(next: DraftEquipmentItem) {
    if (applicability.unit && next.attrs.unit == null) {
      next = setAttr(next, "unit", displayUnit);
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${idPrefix}-label`} className="text-xs text-muted-foreground">
          Name
        </label>
        <Input
          id={`${idPrefix}-label`}
          value={item.label}
          className="h-11 min-w-40 flex-1 text-sm"
          onChange={(event) => change({ ...item, label: event.target.value })}
        />
      </div>

      <div className="flex items-center gap-2">
        <span id={`${idPrefix}-quantity-label`} className="text-xs text-muted-foreground">
          How many {quantityNoun(item)}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="size-11"
            aria-label={`Decrease quantity for ${item.label}`}
            disabled={item.quantity <= 1}
            onClick={() => change({ ...item, quantity: Math.max(1, item.quantity - 1) })}
          >
            <Minus className="size-3.5" />
          </Button>
          <span
            aria-labelledby={`${idPrefix}-quantity-label`}
            className="w-6 text-center text-sm font-medium tabular-nums"
          >
            {item.quantity}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="size-11"
            aria-label={`Increase quantity for ${item.label}`}
            onClick={() => change({ ...item, quantity: Math.min(99, item.quantity + 1) })}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      {applicability.unit && (
        <p className="text-xs text-muted-foreground">
          Weights for this item are recorded in{" "}
          <span className="font-medium text-foreground">{displayUnit}</span>.
        </p>
      )}

      {applicability.benchType && (
        <ChoicePills
          groupLabel={`Bench type for ${item.label}`}
          value={item.attrs.adjustableBench as boolean | undefined}
          options={[
            { value: false, label: "Flat" },
            { value: true, label: "Adjustable" },
          ]}
          onChange={(value) => change(setAttr(item, "adjustableBench", value))}
        />
      )}

      {applicability.adjustable && (
        <ChoicePills
          groupLabel={`Adjustable or fixed for ${item.label}`}
          value={adjustable}
          options={[
            { value: true, label: "Adjustable" },
            { value: false, label: "Fixed weights" },
          ]}
          onChange={(value) => change(setAttr(item, "adjustable", value))}
        />
      )}

      {applicability.pair && (
        <ChoicePills
          groupLabel={`Pair or single for ${item.label}`}
          value={item.attrs.pair as boolean | undefined}
          options={[
            { value: true, label: "Pair" },
            { value: false, label: "Single" },
          ]}
          onChange={(value) => change(setAttr(item, "pair", value))}
        />
      )}

      {applicability.weightRange && adjustable === true && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              id={`${idPrefix}-min-weight`}
              label="Minimum"
              value={(item.attrs.minWeight as number | undefined) ?? null}
              unit={displayUnit}
              onChange={(value) => change(setAttr(item, "minWeight", value))}
            />
            <NumberField
              id={`${idPrefix}-max-weight`}
              label="Maximum"
              value={(item.attrs.maxWeight as number | undefined) ?? null}
              unit={displayUnit}
              onChange={(value) => change(setAttr(item, "maxWeight", value))}
            />
          </div>
          {ownedWeightsEditor(
            item,
            displayUnit,
            change,
            idPrefix,
            "Available weights"
          )}
        </div>
      )}

      {applicability.weightRange &&
        adjustable === false &&
        (item.type === "dumbbell" || item.type === "kettlebell") &&
        ownedWeightsEditor(
          item,
          displayUnit,
          change,
          idPrefix,
          "Owned weights"
        )}

      {applicability.weightRange &&
        adjustable == null &&
        item.type === "medicine_ball" && (
          <NumberField
            id={`${idPrefix}-max-weight`}
            label="Weight"
            value={(item.attrs.maxWeight as number | undefined) ?? null}
            unit={displayUnit}
            onChange={(value) => change(setAttr(item, "maxWeight", value))}
          />
        )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${idPrefix}-brand`} className="text-xs text-muted-foreground">
          Brand (optional)
        </label>
        <Input
          id={`${idPrefix}-brand`}
          value={(item.attrs.brand as string | undefined) ?? ""}
          className="h-11 w-44 text-sm"
          onChange={(event) =>
            change(setAttr(item, "brand", event.target.value || null))
          }
        />
      </div>

      {(levels?.length || notes) && (
        <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Saved details are kept</p>
          {levels?.length ? <p>Levels: {levels.join(", ")}</p> : null}
          {notes ? <p>{notes}</p> : null}
        </div>
      )}
    </div>
  );
}

export function RemoveItemButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11 self-end sm:self-auto"
      aria-label={`Remove ${label}`}
      onClick={onRemove}
    >
      <X className="size-3.5" /> Remove
    </Button>
  );
}
