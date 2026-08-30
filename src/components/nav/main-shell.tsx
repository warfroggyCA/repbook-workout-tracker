"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { BottomTabs } from "@/components/nav/bottom-tabs";
import { cn } from "@/lib/utils";

const SIDEBAR_STORAGE_KEY = "workout-sidebar-collapsed";
const SIDEBAR_EVENT = "workout-sidebar-change";

function getSidebarSnapshot() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function getServerSnapshot() {
  return false;
}

function subscribeToSidebar(onStoreChange: () => void) {
  window.addEventListener(SIDEBAR_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(SIDEBAR_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function MainShell({
  children,
  userName,
  userEmail,
}: {
  children: ReactNode;
  userName?: string;
  userEmail?: string;
}) {
  const sidebarCollapsed = useSyncExternalStore(
    subscribeToSidebar,
    getSidebarSnapshot,
    getServerSnapshot
  );

  function toggleSidebar() {
    try {
      localStorage.setItem(
        SIDEBAR_STORAGE_KEY,
        sidebarCollapsed ? "false" : "true"
      );
    } catch {
      // The sidebar still changes for this tab when storage is unavailable.
    }
    window.dispatchEvent(new Event(SIDEBAR_EVENT));
  }

  return (
    <div
      className={cn(
        "ui-motion-drawer min-h-dvh overflow-x-clip bg-background transition-none lg:transition-[padding]",
        sidebarCollapsed
          ? "lg:pl-[64px] lg:[--main-sidebar-width:64px]"
          : "lg:pl-[224px] lg:[--main-sidebar-width:224px]"
      )}
    >
      <BottomTabs
        userName={userName}
        userEmail={userEmail}
        collapsed={sidebarCollapsed}
        onCollapseToggle={toggleSidebar}
      />
      <div className="mx-auto min-h-dvh max-w-[1180px] pb-20 lg:pb-8">
        {children}
      </div>
    </div>
  );
}
