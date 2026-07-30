"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Minus, Plus, X } from "lucide-react";
import {
  COMMON_PLATE_DENOMINATIONS,
  describePlateRow,
  hasSparePlate,
  type PlateInventoryItem,
} from "@/lib/equipment-inventory-contract";
import { MAX_STORED_LOAD, type LoadUnit } from "@/lib/units";

export type DraftPlate = PlateInventoryItem & { clientKey: string };

const CUSTOM = "custom";
const MAX_PLATE_QUANTITY = 100;

/**
 * Individual-plate inventory editor (UI-006). Every plate size is a distinct
 * unit of inventory with a total quantity, so odd counts are allowed — a lone
 * 45 lb plate is `quantity: 1`. Plates are added through a weight picker plus a
 * quantity, then shown in a compact table with an inline quantity stepper.
 */
export function PlateInventoryEditor({
  plates,
  unit,
  onChange,
}: {
  plates: DraftPlate[];
  unit: LoadUnit;
  onChange: (plates: DraftPlate[]) => void;
}) {
  const [weightChoice, setWeightChoice] = useState<string>("");
  const [customValue, setCustomValue] = useState("");
  const [quantityValue, setQuantityValue] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const sorted = [...plates].sort((a, b) => b.denomination - a.denomination);
  const selectedDenominations = new Set(plates.map((plate) => plate.denomination));
  const availableCommon = COMMON_PLATE_DENOMINATIONS[unit].filter(
    (denomination) => !selectedDenominations.has(denomination)
  );

  function setQuantity(clientKey: string, quantity: number) {
    onChange(
      plates.map((plate) =>
        plate.clientKey === clientKey
          ? { ...plate, quantity: Math.min(MAX_PLATE_QUANTITY, Math.max(1, quantity)) }
          : plate
      )
    );
  }

  function resolveWeight(): number | null {
    if (weightChoice === "" ) {
      setError("Choose a plate size to add.");
      return null;
    }
    const weight = weightChoice === CUSTOM ? Number(customValue) : Number(weightChoice);
    if (!Number.isFinite(weight) || weight <= 0) {
      setError("Enter a plate weight above zero.");
      return null;
    }
    if (Math.round(weight * 100) !== weight * 100) {
      setError("Plate sizes support at most two decimal places.");
      return null;
    }
    if (weight > MAX_STORED_LOAD) {
      setError("That plate weight is beyond the supported range.");
      return null;
    }
    if (selectedDenominations.has(weight)) {
      setError(`${weight} ${unit} is already in your inventory — raise its quantity instead.`);
      return null;
    }
    return weight;
  }

  function addPlate() {
    const weight = resolveWeight();
    if (weight == null) return;
    const quantity = Number(quantityValue);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError("Quantity must be a whole number of at least one.");
      return;
    }
    setError(null);
    onChange([
      ...plates,
      {
        clientKey: crypto.randomUUID(),
        id: null,
        denomination: weight,
        quantity: Math.min(MAX_PLATE_QUANTITY, quantity),
      },
    ]);
    setWeightChoice("");
    setCustomValue("");
    setQuantityValue("1");
    document.getElementById("add-plate-weight")?.focus();
  }

  const summary = sorted
    .map((plate) => describePlateRow(plate.denomination, plate.quantity, unit))
    .join(", ");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Plate weights are recorded in{" "}
        <span className="font-medium text-foreground">{unit}</span>. Add each size
        you own with its total number of plates — single plates are fine.
      </p>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-2">
        <div className="flex flex-col gap-1">
          <label id="add-plate-weight-label" className="text-xs text-muted-foreground">
            Weight
          </label>
          <Select
            value={weightChoice}
            onValueChange={(value) => {
              setWeightChoice(value as string);
              setError(null);
            }}
          >
            <SelectTrigger
              id="add-plate-weight"
              aria-labelledby="add-plate-weight-label"
              className="h-11 w-32"
            >
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {availableCommon.map((denomination) => (
                <SelectItem key={denomination} value={String(denomination)}>
                  {denomination} {unit}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {weightChoice === CUSTOM && (
          <div className="flex flex-col gap-1">
            <label htmlFor="add-plate-custom" className="text-xs text-muted-foreground">
              Custom ({unit})
            </label>
            <Input
              id="add-plate-custom"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.25"
              value={customValue}
              className="h-11 w-24 text-sm"
              onChange={(event) => {
                setCustomValue(event.target.value);
                setError(null);
              }}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="add-plate-quantity" className="text-xs text-muted-foreground">
            Quantity
          </label>
          <Input
            id="add-plate-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            step="1"
            value={quantityValue}
            className="h-11 w-20 text-sm"
            onChange={(event) => {
              setQuantityValue(event.target.value);
              setError(null);
            }}
          />
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={addPlate}
        >
          <Plus className="size-4" /> Add to inventory
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No plate sizes yet. Add the sizes you actually own — nothing is assumed.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 font-medium">Weight</th>
              <th scope="col" className="py-1.5 font-medium">Quantity</th>
              <th scope="col" className="py-1.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((plate) => (
              <tr key={plate.clientKey} className="border-b last:border-0">
                <td className="py-1.5 align-middle">
                  <span className="font-medium tabular-nums">
                    {plate.denomination} {unit}
                  </span>
                  {hasSparePlate(plate.quantity) && (
                    <span className="ml-2 text-xs text-muted-foreground">1 spare</span>
                  )}
                </td>
                <td className="py-1.5 align-middle">
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      className="size-9"
                      aria-label={`Decrease quantity of ${plate.denomination} ${unit} plates`}
                      disabled={plate.quantity <= 1}
                      onClick={() => setQuantity(plate.clientKey, plate.quantity - 1)}
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <label className="sr-only" htmlFor={`plate-qty-${plate.clientKey}`}>
                      Quantity of {plate.denomination} {unit} plates
                    </label>
                    <Input
                      id={`plate-qty-${plate.clientKey}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step="1"
                      value={plate.quantity}
                      className="h-9 w-16 text-center text-sm tabular-nums"
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isInteger(next) && next >= 1) {
                          setQuantity(plate.clientKey, next);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      className="size-9"
                      aria-label={`Increase quantity of ${plate.denomination} ${unit} plates`}
                      onClick={() => setQuantity(plate.clientKey, plate.quantity + 1)}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                </td>
                <td className="py-1.5 text-right align-middle">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-9"
                    aria-label={`Remove ${plate.denomination} ${unit} plates`}
                    onClick={() =>
                      onChange(plates.filter((row) => row.clientKey !== plate.clientKey))
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sorted.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Summary: <span className="text-foreground">{summary}</span>
        </p>
      )}
    </div>
  );
}
