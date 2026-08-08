"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  ClipboardCheck,
  Dumbbell,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardList,
  Settings,
} from "lucide-react";
import { ProductHomeLink } from "@/components/nav/product-mark";
import { Button } from "@/components/ui/button";
import {
  PRODUCT_NAVIGATION,
  PRODUCT_PROMISE,
  PRODUCT_TENETS,
} from "@/lib/product-identity";
import { cn } from "@/lib/utils";

const tabIcons = {
  "/today": Dumbbell,
  "/history": History,
  "/coach": ClipboardCheck,
  "/program": ClipboardList,
  "/settings": Settings,
} as const;

function subscribeToHydration() {
  return () => undefined;
}

function getHydratedSnapshot() {
  return true;
}

function getServerHydratedSnapshot() {
  return false;
}

export function navigationItemIsActive(
  pathname: string | null,
  href: string,
) {
  return pathname != null &&
    (pathname === href || pathname.startsWith(`${href}/`));
}

export function navigationItemShouldPrefetch(
  pathname: string | null,
  href: string,
) {
  return pathname !== href;
}

export function mobileNavigationUsesFocusedWorkoutMode(
  pathname: string | null,
) {
  return pathname != null &&
    (pathname === "/session" || pathname.startsWith("/session/"));
}

export function BottomTabs({
  userName,
  userEmail,
  collapsed,
  onCollapseToggle,
}: {
  userName?: string;
  userEmail?: string;
  collapsed: boolean;
  onCollapseToggle: () => void;
}) {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  );
  // Next can supply a different pathname in the initial browser render after
  // rewrites or history restoration. Keep server and hydration output stable,
  // then apply the current route immediately after hydration.
  const activePathname = hydrated ? pathname : null;
  const displayName = userName || userEmail?.split("@")[0] || "You";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col border-r bg-sidebar py-5 transition-[width,padding] duration-200 motion-reduce:transition-none lg:flex",
          collapsed ? "w-16 px-2" : "w-64 px-4"
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute top-6 -right-3 z-10 rounded-full bg-background shadow-sm"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onCollapseToggle}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-3.5" />
          ) : (
            <PanelLeftClose className="size-3.5" />
          )}
        </Button>

        <ProductHomeLink href="/today" collapsed={collapsed} />

        {!collapsed && (
          <div className="mt-8 border-l-2 border-primary/50 px-3 py-1">
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {PRODUCT_TENETS}
            </p>
            <p className="mt-1 text-sm font-medium">{PRODUCT_PROMISE}</p>
          </div>
        )}

        <nav
          className={cn(
            "flex flex-1 flex-col gap-1",
            collapsed ? "mt-8" : "mt-5"
          )}
          aria-label="Main navigation"
        >
          {PRODUCT_NAVIGATION.map(({ href, label, purpose }) => {
            const Icon = tabIcons[href];
            const active = navigationItemIsActive(activePathname, href);
            return (
              <Link
                key={href}
                href={href}
                prefetch={
                  navigationItemShouldPrefetch(activePathname, href)
                    ? null
                    : false
                }
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors motion-reduce:transition-none",
                  collapsed && "justify-center px-2",
                  active
                    ? "bg-primary/10 font-medium text-accent-foreground"
                    : "text-foreground/75 hover:bg-muted hover:text-foreground"
                )}
                title={collapsed ? label : undefined}
              >
                <Icon className="size-[1.1875rem]" strokeWidth={active ? 2.25 : 1.8} />
                {!collapsed && (
                  <span className="min-w-0 leading-tight">
                    <span className="block">{label}</span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 block truncate text-[0.625rem] font-normal",
                        active
                          ? "text-accent-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {purpose}
                    </span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div
          className={cn(
            "flex items-center gap-3 border-t pt-4",
            collapsed && "justify-center"
          )}
          title={collapsed ? displayName : undefined}
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold">
            {initial}
          </span>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{displayName}</p>
              {userEmail && (
                <p className="truncate text-xs text-muted-foreground">
                  {userEmail}
                </p>
              )}
            </div>
          )}
        </div>
      </aside>

      <nav
        aria-label="Primary navigation"
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden",
          mobileNavigationUsesFocusedWorkoutMode(activePathname) &&
            "max-[359px]:hidden",
        )}
      >
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {PRODUCT_NAVIGATION.map(({ href, label }) => {
            const Icon = tabIcons[href];
            const active = navigationItemIsActive(activePathname, href);
            return (
              <Link
                key={href}
                href={href}
                prefetch={
                  navigationItemShouldPrefetch(activePathname, href)
                    ? null
                    : false
                }
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5 py-2 text-[0.625rem] leading-tight transition-colors motion-reduce:transition-none",
                  active
                    ? "font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {active && (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />
                )}
                <Icon className="size-5" strokeWidth={active ? 2.4 : 1.8} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
