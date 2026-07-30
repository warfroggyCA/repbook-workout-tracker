"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { activateSetupProgram } from "@/app/actions/setup";
import { Button } from "@/components/ui/button";

export function ActivateButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        size="lg"
        disabled={disabled || pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await activateSetupProgram();
            if (!result.ok) {
              setError(result.reason);
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
