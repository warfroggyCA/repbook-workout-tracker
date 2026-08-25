import { notFound } from "next/navigation";
import { ProgramEditor } from "@/components/program/program-editor";
import { getDb } from "@/db";
import { exerciseDiscoveryItemFromLibrary } from "@/lib/exercise-discovery";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getCurrentUser } from "@/lib/user";
import { getLibraryWithAvailability } from "@/services/routine-import";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

export default async function ProgramEditPage(props: PageProps<"/program/edit">) {
  if (!isProgramEditorEnabled()) notFound();

  const user = await getCurrentUser();
  const db = await getDb();
  const library = (await getLibraryWithAvailability(db, user.id)).map((exercise) =>
    exerciseDiscoveryItemFromLibrary(exercise)
  );

  const query = await props.searchParams;
  const initialDayId = typeof query.day === "string" ? query.day : null;
  const initialRemovalRequest =
    query.intent === "remove" &&
    typeof query.program === "string" &&
    typeof query.day === "string" &&
    typeof query.slot === "string" &&
    typeof query.exercise === "string"
      ? {
          programId: query.program,
          dayLineageId: query.day,
          slotLineageId: query.slot,
          exerciseId: query.exercise,
        }
      : null;
  return (
    <ProgramEditor
      ownerId={user.id}
      library={library}
      initialDayId={initialDayId}
      initialRemovalRequest={initialRemovalRequest}
    />
  );
}
