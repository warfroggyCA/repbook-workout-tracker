import type { Metadata } from "next";
import { SimulationShell } from "@/components/simulation/simulation-shell";
import { FontSizeInitializer } from "@/components/settings/font-size-initializer";
import { Toaster } from "@/components/ui/sonner";
import { normalizeFontSize } from "@/lib/font-size";
import { getCurrentUser } from "@/lib/user";

export const metadata: Metadata = {
  title: "Workout simulation — not recorded",
};

export default async function SimulationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  return (
    <>
      <FontSizeInitializer
        profileSize={normalizeFontSize(user.profile.fontSize)}
      />
      <SimulationShell userEmail={user.email}>{children}</SimulationShell>
      <Toaster position="top-center" richColors />
    </>
  );
}
