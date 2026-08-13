import { MainShell } from "@/components/nav/main-shell";
import { FontSizeInitializer } from "@/components/settings/font-size-initializer";
import { normalizeFontSize } from "@/lib/font-size";
import { getCurrentUser } from "@/lib/user";
import { Toaster } from "@/components/ui/sonner";
import { LiveCoachOutboxSync } from "@/components/session/live-coach-outbox-sync";
import { after } from "next/server";
import { getDb } from "@/db";
import { processProgressionJob } from "@/services/progression-jobs";
import { WorkoutSetOutboxSync } from "@/components/session/workout-set-outbox-sync";
import { OccurrenceMutationOutboxSync } from "@/components/session/occurrence-mutation-outbox-sync";
import { ContextualNoteProvider } from "@/components/contextual-notes/contextual-note-provider";
import { ContextualNoteOutboxSync } from "@/components/contextual-notes/contextual-note-outbox-sync";
import { DeploymentUpdateNotice } from "@/components/deployment-update-notice";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  after(async () => {
    try {
      const db = await getDb();
      await processProgressionJob(db, undefined, { userId: user.id });
    } catch {
      // The durable job remains visible to recovery checks and will be retried
      // on a later authenticated request.
    }
  });
  return (
    <>
      <FontSizeInitializer
        profileSize={normalizeFontSize(user.profile.fontSize)}
      />
      <MainShell
        userName={user.name ?? undefined}
        userEmail={user.email}
      >
        <DeploymentUpdateNotice />
        <ContextualNoteProvider ownerId={user.id}>
          <ContextualNoteOutboxSync ownerId={user.id} />
          <WorkoutSetOutboxSync ownerId={user.id} />
          {children}
        </ContextualNoteProvider>
      </MainShell>
      <OccurrenceMutationOutboxSync ownerId={user.id} />
      <LiveCoachOutboxSync ownerId={user.id} />
      <Toaster position="top-center" richColors />
    </>
  );
}
