import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Today" };

export default function TodayLayout({ children }: { children: ReactNode }) {
  return children;
}

