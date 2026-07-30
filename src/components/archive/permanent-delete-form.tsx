"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { permanentlyDeleteArchiveOperation } from "@/app/actions/permanent-delete";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PERMANENT_DELETE_CONFIRMATION } from "@/services/permanent-delete";

export function PermanentDeleteForm({
  operationId,
  summary,
}: {
  operationId: string;
  summary: string;
}) {
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = acknowledged && confirmation === PERMANENT_DELETE_CONFIRMATION;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-950">
        <Checkbox
          id="delete-acknowledgement"
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <label htmlFor="delete-acknowledgement" className="leading-relaxed">
          I reviewed the exact preview for “{summary}”. I understand these records
          will no longer be restorable from the Archive after this operation.
        </label>
      </div>
      <div className="space-y-2">
        <label htmlFor="delete-confirmation" className="text-sm font-medium">
          Type {PERMANENT_DELETE_CONFIRMATION} to continue
        </label>
        <Input
          id="delete-confirmation"
          autoComplete="off"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={PERMANENT_DELETE_CONFIRMATION}
        />
      </div>
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" /> A verified safety copy is mandatory
        </p>
        <p className="mt-1 leading-relaxed">
          The app first stores and verifies a new encrypted snapshot. Any identity,
          preview, snapshot, or deletion failure leaves the Archive action recoverable.
        </p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button
        type="button"
        variant="destructive"
        disabled={!ready || pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await permanentlyDeleteArchiveOperation({
              operationId,
              confirmation,
              acknowledged,
            });
            if (!result.ok) {
              setError(result.reason);
              return;
            }
            toast.success("Archived records permanently deleted", {
              description: "The audit trail and verified safety copy were preserved.",
            });
            router.push("/archive");
            router.refresh();
          })
        }
      >
        <Trash2 className="size-4" />
        {pending ? "Protecting and deleting…" : "Create safety copy and delete permanently"}
      </Button>
    </div>
  );
}
