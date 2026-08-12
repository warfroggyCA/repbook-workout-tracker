"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { InventoryChangePreview } from "@/services/equipment-inventory";
import { labelForEquipmentType } from "@/lib/equipment-families";
import type { LoadUnit } from "@/lib/units";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-1.5 text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function quantityLabel(quantity: number) {
  return `${quantity} ${quantity === 1 ? "plate" : "plates"}`;
}

/**
 * Server-confirmed change and impact review. The preview was computed by the
 * server from the owned current inventory and this exact draft; capability
 * reductions require the explicit confirmation below before saving.
 */
export function InventoryChangeReview({
  preview,
  unit,
  pending,
  onBack,
  onConfirm,
}: {
  preview: InventoryChangePreview;
  unit: LoadUnit;
  pending: boolean;
  onBack: () => void;
  onConfirm: (confirmedCapabilityReduction: boolean) => void;
}) {
  const [confirmed, setConfirmed] = useState(!preview.requiresConfirmation);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const unavailable = preview.impact.exercisesBecomingUnavailable;
  const nowAvailable = preview.impact.exercisesBecomingAvailable;
  const affectedSlots = preview.impact.affectedProgramSlots;
  const fitReviews = preview.impact.fitReviewsRequiringReview;

  return (
    <div className="flex flex-col gap-3 [&_button]:min-h-11 [&_button]:min-w-11">
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        Review inventory changes
      </h2>

      {preview.added.length > 0 && (
        <Section title="Added">
          <ul className="list-inside list-disc text-sm">
            {preview.added.map((item, index) => (
              <li key={index}>
                {item.label}{" "}
                <span className="text-muted-foreground">
                  ({labelForEquipmentType(item.type)})
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {preview.changed.length > 0 && (
        <Section title="Changed">
          <ul className="list-inside list-disc text-sm">
            {preview.changed.map((item) => (
              <li key={item.id}>
                {item.label}{" "}
                <span className="text-muted-foreground">
                  ({item.changedFields.join(", ")})
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {preview.removed.length > 0 && (
        <Section title="No longer available">
          <ul className="list-inside list-disc text-sm">
            {preview.removed.map((item) => (
              <li key={item.id}>
                {item.label}{" "}
                <span className="text-muted-foreground">
                  ({labelForEquipmentType(item.type)})
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Removed equipment is retired, not deleted: its history stays intact
            and re-adding the same item later restores the same record.
          </p>
        </Section>
      )}

      {preview.plateChanges.length > 0 && (
        <Section title="Plate changes">
          <ul className="list-inside list-disc text-sm">
            {preview.plateChanges.map((change, index) => (
              <li key={index}>
                {change.denomination} {unit}:{" "}
                {change.fromQuantity == null
                  ? `added at ${quantityLabel(change.toQuantity ?? 1)}`
                  : change.toQuantity == null
                    ? `removed (was ${quantityLabel(change.fromQuantity)})`
                    : `${quantityLabel(change.fromQuantity)} → ${quantityLabel(change.toQuantity)}`}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {preview.barChanges.length > 0 && (
        <Section title="Bar configuration changes">
          <ul className="list-inside list-disc text-sm">
            {preview.barChanges.map((change, index) => (
              <li key={index}>
                <span className="font-medium">{change.label}</span>
                {change.added && change.after && (
                  <span className="text-muted-foreground"> — added at {change.after.barWeight} {unit}; collars {change.after.collarWeight} {unit} total; empty assembled load {change.after.barWeight + change.after.collarWeight} {unit}</span>
                )}
                {change.removed && change.before && (
                  <span className="text-muted-foreground"> — removed (was {change.before.barWeight} {unit}; collars {change.before.collarWeight} {unit} total; empty assembled load {change.before.barWeight + change.before.collarWeight} {unit})</span>
                )}
                {!change.added && !change.removed && change.before && change.after && (
                  <ul className="ml-5 list-disc text-muted-foreground">
                    {change.before.barWeight !== change.after.barWeight && <li>Empty bar weight: {change.before.barWeight} {unit} → {change.after.barWeight} {unit}</li>}
                    {change.before.collarWeight !== change.after.collarWeight && <li>Both collars, total: {change.before.collarWeight} {unit} → {change.after.collarWeight} {unit}</li>}
                    <li>Empty assembled load: {change.before.barWeight + change.before.collarWeight} {unit} → {change.after.barWeight + change.after.collarWeight} {unit}</li>
                    {change.changedFields.filter((field) => field !== "bar weight" && field !== "collar weight").map((field) => <li key={field}>{field}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Future plate guidance and progression steps will use the saved empty bar and collar values. Already logged totals and workout history stay unchanged.
          </p>
        </Section>
      )}

      {preview.loadProfileChanges.length > 0 && (
        <Section title="Exact setup changes">
          <ul className="list-inside list-disc text-sm">
            {preview.loadProfileChanges.map((change) => (
              <li key={change.equipmentItemId}>
                <span className="font-medium">{change.label}</span>{" "}
                <span className="text-muted-foreground">
                  — exact setup {change.change}
                  {change.reducesGuidance ? "; future loading guidance becomes less precise" : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            These values affect future setup and loading guidance only. Saved workouts keep the exact equipment snapshot recorded when they were performed.
          </p>
        </Section>
      )}

      {fitReviews.length > 0 && (
        <Section title="Movement reviews to revisit">
          <p className="text-sm">
            This save changes capability evidence used by these exact exercise-and-item
            reviews. They will be treated as unknown until you review and save them again:
          </p>
          <ul className="mt-2 list-inside list-disc text-sm text-muted-foreground">
            {fitReviews.map((review) => (
              <li key={review.assertionId}>
                {review.exerciseName} with {review.equipmentLabel}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Existing Programs, active-session snapshots, completed workouts, imported
            History, and earlier Program versions are not rewritten.
          </p>
        </Section>
      )}

      <Section title="Training impact">
        {unavailable.length === 0 && nowAvailable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No exercise becomes available or unavailable from this change.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {unavailable.length > 0 && (
              <div>
                <p className="font-medium">
                  {unavailable.length} exercise
                  {unavailable.length === 1 ? "" : "s"} will no longer be
                  available:
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {unavailable.slice(0, 12).map((exercise) => (
                    <li key={exercise.id}>{exercise.name}</li>
                  ))}
                  {unavailable.length > 12 && (
                    <li>…and {unavailable.length - 12} more</li>
                  )}
                </ul>
              </div>
            )}
            {affectedSlots.length > 0 && (
              <div>
                <p className="font-medium">
                  Your current Program uses{" "}
                  {affectedSlots.length === 1
                    ? "one of these exercises"
                    : `${affectedSlots.length} of these slots`}
                  :
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {affectedSlots.map((slot, index) => (
                    <li key={index}>
                      {slot.exerciseName} ({slot.dayName})
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">
                  The Program itself is not rewritten. Affected workouts can use
                  server-checked alternatives, or you can edit the Program
                  separately.
                </p>
              </div>
            )}
            {nowAvailable.length > 0 && (
              <p>
                {nowAvailable.length} exercise
                {nowAvailable.length === 1 ? "" : "s"} become
                {nowAvailable.length === 1 ? "s" : ""} newly available.
              </p>
            )}
          </div>
        )}
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Broad availability here reports equipment type, active status,
          constraints, and an optional maximum-weight requirement. It is not
          proof that an exact exercise-and-item pair works. Exercise discovery,
          Coach, and workout alternatives also require current positive exact-pair
          evidence, and every choice is rechecked on the server before it applies.
          Active, current, and historical workouts remain unchanged, and the
          current Program is not rewritten.
        </p>
      </Section>

      {preview.requiresConfirmation && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3">
          <Checkbox
            id="confirm-capability-reduction"
            checked={confirmed}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
          />
          <Label
            htmlFor="confirm-capability-reduction"
            className="text-sm leading-5"
          >
            I understand this save removes equipment, reduces what I can lift,
            makes future loading guidance less precise, or makes the listed
            movement reviews unknown until I review them again, and these are
            the changes I want.
          </Label>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className="sm:flex-1"
          disabled={pending}
          onClick={onBack}
        >
          Keep editing
        </Button>
        <Button
          type="button"
          className="sm:flex-1"
          disabled={pending || (preview.requiresConfirmation && !confirmed)}
          onClick={() => onConfirm(confirmed)}
        >
          {pending ? "Saving…" : "Save inventory"}
        </Button>
      </div>
    </div>
  );
}
