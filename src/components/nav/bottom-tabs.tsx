"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useSyncExternalStore } from "react";
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
import { PRODUCT_NAVIGATION } from "@/lib/product-identity";
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

export function navigationItemRequiresDocumentNavigation(
  pathname: string | null,
) {
  return mobileNavigationUsesFocusedWorkoutMode(pathname);
}

function NavigationItemLink({
  href,
  label,
  active,
  className,
  title,
  forceDocumentNavigation,
  prefetch,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  className: string;
  title?: string;
  forceDocumentNavigation: boolean;
  prefetch: boolean | null;
  children: ReactNode;
}) {
  const sharedProps = {
    "aria-label": label,
    "aria-current": active ? ("page" as const) : undefined,
    className,
    title,
  };
  return forceDocumentNavigation ? (
    <a href={href} {...sharedProps}>
      {children}
    </a>
  ) : (
    <Link href={href} prefetch={prefetch} {...sharedProps}>
      {children}
    </Link>
  );
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
  const focusedWorkoutMode = mobileNavigationUsesFocusedWorkoutMode(
    activePathname,
  );
  const displayName = userName || userEmail?.split("@")[0] || "You";
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <>
      <aside
        className={cn(
          "ui-motion-drawer fixed inset-y-0 left-0 z-40 hidden flex-col border-r bg-sidebar py-5 transition-[width,padding] lg:flex",
          collapsed ? "w-[64px] px-2" : "w-[224px] px-3"
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

        <ProductHomeLink
          href="/today"
          collapsed={collapsed}
          forceDocumentNavigation={focusedWorkoutMode}
        />

        <nav
          className={cn(
            "flex flex-1 flex-col gap-1",
            collapsed ? "mt-8" : "mt-10"
          )}
          aria-label="Main navigation"
        >
          {PRODUCT_NAVIGATION.map(({ href, label }) => {
            const Icon = tabIcons[href];
            const active = navigationItemIsActive(activePathname, href);
            const forceDocumentNavigation =
              navigationItemRequiresDocumentNavigation(activePathname);
            const itemClassName = cn(
              "ui-motion-immediate flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              collapsed && "justify-center px-2",
              active
                ? "bg-primary/10 font-medium text-accent-foreground"
                : "text-foreground/75 hover:bg-muted hover:text-foreground"
            );
            const itemContent = (
              <>
                <Icon className="size-[1.1875rem]" strokeWidth={active ? 2.25 : 1.8} />
                {!collapsed && (
                  <span className="min-w-0 truncate leading-tight">{label}</span>
                )}
              </>
            );
            return (
              <NavigationItemLink
                key={href}
                href={href}
                label={label}
                active={active}
                className={itemClassName}
                title={collapsed ? label : undefined}
                forceDocumentNavigation={forceDocumentNavigation}
                prefetch={
                  navigationItemShouldPrefetch(activePathname, href)
                    ? null
                    : false
                }
              >
                {itemContent}
              </NavigationItemLink>
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
            "hidden",
        )}
      >
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {PRODUCT_NAVIGATION.map(({ href, label }) => {
            const Icon = tabIcons[href];
            const active = navigationItemIsActive(activePathname, href);
            const forceDocumentNavigation =
              navigationItemRequiresDocumentNavigation(activePathname);
            const itemClassName = cn(
              "ui-motion-immediate relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5 py-2 text-[0.625rem] leading-tight transition-colors",
              active
                ? "font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            );
            const itemContent = (
              <>
                {active && (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />
                )}
                <Icon className="size-5" strokeWidth={active ? 2.4 : 1.8} />
                {label}
              </>
            );
            return (
              <NavigationItemLink
                key={href}
                href={href}
                label={label}
                active={active}
                className={itemClassName}
                forceDocumentNavigation={forceDocumentNavigation}
                prefetch={
                  navigationItemShouldPrefetch(activePathname, href)
                    ? null
                    : false
                }
              >
                {itemContent}
              </NavigationItemLink>
            );
          })}
        </div>
      </nav>
    </>
  );
}
