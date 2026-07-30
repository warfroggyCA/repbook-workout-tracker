import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Export" };

export default function ExportLayout({ children }: { children: ReactNode }) {
  return children;
}

