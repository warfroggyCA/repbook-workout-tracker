import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Active workout" };

export default function SessionLayout({ children }: { children: ReactNode }) {
  return children;
}

