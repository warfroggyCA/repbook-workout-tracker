"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CheckCircle2,
  ClipboardList,
  Dumbbell,
  HeartPulse,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { ProductHomeLink } from "@/components/nav/product-mark";
import { SETUP_STEPS } from "@/lib/setup-steps";
import { cn } from "@/lib/utils";

const icons = [
  Settings2,
  Dumbbell,
  HeartPulse,
  ClipboardList,
  SlidersHorizontal,
  CheckCircle2,
];

export function SetupSidebar({
  userName,
  userEmail,
}: {
  userName?: string;
  userEmail?: string;
}) {
  const pathname = usePathname();
  const displayName = userName || userEmail?.split("@")[0] || "You";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r bg-sidebar px-4 py-5 lg:flex">
      <ProductHomeLink href="/setup" label="Repbook setup home" />

      <div className="mt-8 border-l-2 border-primary/50 px-3 py-1">
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Record setup
        </p>
        <p className="mt-1 text-sm leading-5 text-foreground/75">
          Set equipment, constraints, and Program intent.
        </p>
      </div>

      <nav className="mt-5 flex flex-1 flex-col gap-1" aria-label="Setup navigation">
        {SETUP_STEPS.map((step, index) => {
          const href = `/setup/${step.slug}`;
          const active = pathname === href;
          const Icon = icons[index];
          return (
            <Link
              key={step.slug}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors motion-reduce:transition-none",
                active
                  ? "bg-accent font-medium text-primary"
                  : "text-foreground/75 hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="size-[1.1875rem]" strokeWidth={active ? 2.25 : 1.8} />
              {step.title}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3 border-t pt-4">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold">
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{displayName}</p>
          {userEmail && (
            <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
          )}
        </div>
      </div>
    </aside>
  );
}
