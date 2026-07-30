"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { EquipmentFamilyIcon } from "@/components/equipment/equipment-family-icon";
import type { EquipmentInventoryGroup } from "@/lib/equipment-families";

function itemCountLabel(count: number) {
  return `${count} item${count === 1 ? "" : "s"}`;
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function quantityLabel(item: EquipmentInventoryGroup["items"][number]) {
  if (item.type === "barbell" || item.type === "ez_bar") {
    return item.quantity === 1 ? "1 bar" : `${item.quantity} identical bars`;
  }
  if (item.type === "dumbbell" && item.attrs.pair === true) {
    return `${item.quantity} pair${item.quantity === 1 ? "" : "s"}`;
  }
  if (item.type === "dumbbell" || item.type === "kettlebell") {
    return `${item.quantity} single${item.quantity === 1 ? "" : "s"}`;
  }
  return `${item.quantity} item${item.quantity === 1 ? "" : "s"}`;
}

function DetailChips({ details }: { details: string[] }) {
  if (details.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {details.map((detail, index) => (
        <span
          key={`${detail}-${index}`}
          className="max-w-full break-words rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {detail}
        </span>
      ))}
    </div>
  );
}

export function EquipmentInventory({
  groups,
}: {
  groups: EquipmentInventoryGroup[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-4">
        <p className="text-sm font-medium">No equipment recorded.</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Nothing is being changed here. Your workouts, program, and history remain
          available as recorded.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2" aria-label="Equipment inventory">
      {groups.map((group) => {
        const isExpanded = expanded.has(group.key);
        const regionId = `equipment-family-${group.key}`;
        return (
          <section
            key={group.key}
            data-equipment-family={group.key}
            className="overflow-hidden rounded-xl border bg-background"
          >
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={regionId}
              className="flex min-h-[56px] w-full items-center gap-[10px] px-[10px] py-[12px] text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })
              }
            >
              {isExpanded ? (
                <ChevronDown className="size-[16px] shrink-0" />
              ) : (
                <ChevronRight className="size-[16px] shrink-0" />
              )}
              <EquipmentFamilyIcon familyKey={group.key} />
              <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold">{group.name}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {itemCountLabel(group.items.length + group.supplements.length)}
                </span>
              </span>
            </button>

            <div
              id={regionId}
              role="region"
              aria-label={`${group.name} items`}
              hidden={!isExpanded}
              className="divide-y border-t"
            >
              <ul className="divide-y">
                {group.items.map((item) => (
                  <li key={item.id} className="min-w-0 px-3 py-3">
                    <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium text-foreground">
                          {item.label}
                        </p>
                        {!normalized(item.label).includes(normalized(item.typeLabel)) && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.typeLabel}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 self-start rounded-full border px-2 py-1 text-xs font-medium tabular-nums text-foreground">
                        {quantityLabel(item)}
                      </span>
                    </div>

                    <DetailChips details={item.details} />

                    {item.definitionDescription && (
                      <p className="mt-2 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                        {item.definitionDescription}
                      </p>
                    )}

                    {item.plateDenominations.length > 0 && (
                      <div className="mt-3 rounded-lg border bg-muted/25 p-2.5">
                        <p className="text-xs font-semibold text-foreground">
                          Plate denominations
                        </p>
                        <DetailChips details={item.plateDenominations} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {group.supplements.map((supplement) => (
                <div key={supplement.id} className="min-w-0 px-3 py-3">
                  <p className="break-words text-sm font-medium text-foreground">
                    {supplement.label}
                  </p>
                  <DetailChips details={supplement.details} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
