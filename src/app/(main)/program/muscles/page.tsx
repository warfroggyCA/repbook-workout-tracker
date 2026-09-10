import Link from "next/link";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { getActiveProgramPresentation } from "@/services/program-presentation";
import { ProgramMuscleMap } from "@/components/muscle-map/program-muscle-map";

export default async function ProgramMusclesPage({
  searchParams,
}: PageProps<"/program/muscles">) {
  const user = await getCurrentUser();
  const db = await getDb();
  const program = await getActiveProgramPresentation(db, user.id);
  if (!program || program.days.length === 0)
    return (
      <main className="p-6">
        <Link href="/program">← Program</Link>
        <h1 className="mt-4 text-2xl font-semibold">Muscle coverage</h1>
        <p className="mt-3 text-muted-foreground">
          Save a Program with workout days to explore its planned muscle
          coverage.
        </p>
      </main>
    );
  const query = await searchParams;
  const requestedDay = typeof query.day === "string" ? query.day : null;
  const initialDayId =
    program.days.find((day) => day.lineageId === requestedDay)?.lineageId ??
    null;
  return (
    <ProgramMuscleMap
      key={`${program.program.id}:${initialDayId ?? "all"}`}
      program={program}
      initialDayId={initialDayId}
      unavailableDay={requestedDay !== null && initialDayId === null}
    />
  );
}
