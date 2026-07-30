import Link from "next/link";
import { FlaskConical, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SimulationShell({
  children,
  userEmail,
}: {
  children: React.ReactNode;
  userEmail: string;
}) {
  return (
    <div className="min-h-dvh bg-amber-50/60 text-foreground dark:bg-amber-950/15">
      <header className="sticky top-0 z-50 border-b-2 border-amber-500 bg-amber-100/95 px-[max(1rem,env(safe-area-inset-left))] pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-sm backdrop-blur dark:bg-amber-950/95">
        <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3 sm:items-center">
          <FlaskConical aria-hidden="true" className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-bold uppercase tracking-wide">
              Simulation — not recorded
            </p>
            <p className="text-xs text-muted-foreground sm:text-sm">
              Nothing here changes Today, History, Coach, progress, or records.
            </p>
          </div>
          <Button
            variant="outline"
            size="touch"
            className="w-full sm:w-auto"
            render={<Link href="/today" />}
            nativeButton={false}
          >
            <LogOut aria-hidden="true" /> Exit simulation
          </Button>
        </div>
      </header>
      <div className="sr-only">Signed in as {userEmail}</div>
      {children}
    </div>
  );
}
