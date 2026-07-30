"use client";

import { useRef, type ReactNode } from "react";
import { acceptCompilerProposal } from "@/app/actions/session-compiler";
import { Button } from "@/components/ui/button";

export function CompilerAcceptForm({
  proposalId,
  acceptanceKey,
  fallbackTimezone,
  children,
}: {
  proposalId: string;
  acceptanceKey: string;
  fallbackTimezone: string;
  children: ReactNode;
}) {
  const timezoneInput = useRef<HTMLInputElement>(null);
  return (
    <form
      action={acceptCompilerProposal.bind(null, proposalId, acceptanceKey)}
      className="space-y-3"
      onSubmit={() => {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected && timezoneInput.current) timezoneInput.current.value = detected;
      }}
    >
      <input ref={timezoneInput} type="hidden" name="timezone" defaultValue={fallbackTimezone} />
      <label className="flex items-start gap-3 rounded-xl border p-3 text-sm leading-6">
        <input className="mt-1 size-4" type="checkbox" name="reviewConfirmation" value="reviewed" required />
        <span>I reviewed the exercises, dose changes, duration range, warnings, and deferred work. Start this proposal without changing my Program.</span>
      </label>
      <Button type="submit" size="lg" className="h-auto min-h-12 w-full whitespace-normal py-3">{children}</Button>
    </form>
  );
}
