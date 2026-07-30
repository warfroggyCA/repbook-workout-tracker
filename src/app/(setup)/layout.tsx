import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { SetupSidebar } from "@/components/nav/setup-sidebar";

export const metadata: Metadata = { title: "Set up your training record" };

export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  return (
    <div className="min-h-dvh bg-background lg:pl-64">
      <SetupSidebar
        userName={session.user?.name ?? undefined}
        userEmail={session.user?.email ?? undefined}
      />
      <div className="mx-auto min-h-dvh max-w-[1180px] pb-10">{children}</div>
    </div>
  );
}
