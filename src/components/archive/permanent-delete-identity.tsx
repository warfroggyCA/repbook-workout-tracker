"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import {
  beginPermanentDeleteReauthentication,
  completeDevPermanentDeleteReauthentication,
} from "@/app/actions/permanent-delete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PermanentDeleteIdentity({
  operationId,
  devMode,
  ownerEmail,
}: {
  operationId: string;
  devMode: boolean;
  ownerEmail: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function verify() {
    startTransition(async () => {
      setError(null);
      const result = devMode
        ? await completeDevPermanentDeleteReauthentication(operationId, email)
        : await beginPermanentDeleteReauthentication(operationId);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      if (devMode) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-950">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" /> A new identity check is required
        </p>
        <p className="mt-1 leading-relaxed">
          Your normal signed-in session is not enough. The new check creates a
          short-lived, single-use permission for this Archive action only.
        </p>
      </div>
      {devMode ? (
        <div className="space-y-2">
          <label htmlFor="dev-reauth-email" className="text-sm font-medium">
            Re-enter the signed-in development email
          </label>
          <Input
            id="dev-reauth-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={ownerEmail}
          />
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button
        type="button"
        variant="outline"
        disabled={pending || (devMode && email.trim().length === 0)}
        onClick={verify}
      >
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        {pending
          ? "Verifying identity…"
          : devMode
            ? "Verify development identity"
            : "Verify with GitHub"}
      </Button>
    </div>
  );
}
