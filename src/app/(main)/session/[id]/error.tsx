"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function SessionError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-xl items-center px-4 py-8">
      <section className="w-full rounded-2xl border bg-card p-5 shadow-[var(--shadow-soft)]">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary">
          Workout recovery
        </p>
        <h1 className="mt-2 text-xl font-semibold">Check this workout’s status</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          We could not confirm this workout’s status just now. Try loading it
          again, or return to Today. Today will show Resume workout if one exists.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button type="button" onClick={() => unstable_retry()} className="min-h-12">
            Try loading again
          </Button>
          <Button
            variant="outline"
            render={<Link href="/today" />}
            nativeButton={false}
            className="min-h-12"
          >
            Return to Today
          </Button>
        </div>
      </section>
    </main>
  );
}
