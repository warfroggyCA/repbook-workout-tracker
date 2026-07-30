import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Recovery" };

export default function RecoveryLayout({ children }: { children: ReactNode }) {
  return children;
}

