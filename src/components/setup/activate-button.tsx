"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { activateSetupProgram } from "@/app/actions/setup";
import { Button } from "@/components/ui/button";

export function ActivateButton({
  disabled,
  requiresEquipmentFitReview,
  equipmentFitReviewToken,
}: {
  disabled: boolean;
  requiresEquipmentFitReview: boolean;
  equipmentFitReviewToken: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [equipmentFitReviewed, setEquipmentFitReviewed] = useState(false);
  const [pending, startTransition] = useTransition();
  const errorRef = useRef<HTMLParagraphElement>(null);

  function announceError(message: string) {
    setError(message);
    window.setTimeout(() => errorRef.current?.focus(), 0);
  }

  return (
    <div className="flex flex-col gap-2">
      {requiresEquipmentFitReview ? (
        <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            checked={equipmentFitReviewed}
            disabled={pending}
            onChange={(event) => setEquipmentFitReviewed(event.target.checked)}
          />
          <span>
            <span className="block font-medium">
              I checked every equipment-required exercise against the exact item and setup I will use.
            </span>
            <span className="mt-1 block text-muted-foreground">
              This applies only to this activation and does not create a retained compatibility review.
              A retained incompatibility still blocks activation. After setup, durable reviews live in
              Settings → Equipment.
            </span>
          </span>
        </label>
      ) : null}
      <p
        ref={errorRef}
        tabIndex={-1}
        role="alert"
        aria-atomic="true"
        className={
          error
            ? "rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            : "sr-only"
        }
      >
        {error ?? ""}
      </p>
      <Button
        size="lg"
        disabled={
          disabled
          || pending
          || (requiresEquipmentFitReview && !equipmentFitReviewed)
        }
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await activateSetupProgram({
              // Never manufacture an attestation when the checkbox was not
              // rendered. A requirement added during review issuance must
              // therefore fail closed even if the revision read saw it.
              equipmentFitReviewed,
              equipmentFitReviewToken,
            });
            if (!result.ok) {
              announceError(result.reason);
              return;
            }
            router.push("/today");
          });
        }}
      >
        {pending ? "Activating…" : "Activate program"}
      </Button>
    </div>
  );
}
