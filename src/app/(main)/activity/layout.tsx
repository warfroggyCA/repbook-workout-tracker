import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Activity record" };

export default function ActivityLayout({ children }: { children: ReactNode }) {
  return children;
}
