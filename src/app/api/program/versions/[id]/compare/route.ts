import { z } from "zod";
import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { exercises, programVersions } from "@/db/schema";
import { sensitiveJson } from "@/lib/http-security";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import {
  getCurrentProgramDocument,
  getOwnedProgramVersionDocument,
  reviewProgramDocuments,
} from "@/services/program-documents";
import { programPreflightResultSchema } from "@/lib/program-preflight";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isProgramEditorEnabled()) return sensitiveJson({ reason: "Not found." }, { status: 404 });
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Sign in again." }, { status: 401 });
  const parsed = z.string().uuid().safeParse((await context.params).id);
  if (!parsed.success) return sensitiveJson({ reason: "Not found." }, { status: 404 });
  const db = await getDb();
  const [historical, current] = await Promise.all([
    getOwnedProgramVersionDocument(db, user.id, parsed.data),
    getCurrentProgramDocument(db, user.id),
  ]);
  if (!historical || !current || historical.programId !== current.programId) {
    return sensitiveJson({ reason: "That Program version is no longer available." }, { status: 404 });
  }
  const exerciseIds = [...new Set(
    [...historical.days, ...current.days].flatMap((day) => day.exercises.map((slot) => slot.exerciseId))
  )];
  const exerciseRows = exerciseIds.length
    ? await db.query.exercises.findMany({
        where: inArray(exercises.id, exerciseIds),
        columns: { id: true, name: true, primaryMuscles: true },
      })
    : [];
  const comparedVersionRows = await db.query.programVersions.findMany({
    where: inArray(programVersions.id, [parsed.data, current.baseVersionId]),
    columns: { id: true, publicationPreflight: true },
  });
  const publicationPreflightByVersion = new Map(
    comparedVersionRows.map((version) => {
      const parsedPreflight = programPreflightResultSchema.safeParse(
        version.publicationPreflight,
      );
      return [version.id, parsedPreflight.success ? parsedPreflight.data : null];
    }),
  );
  const comparableCurrent = { ...current, baseVersionId: historical.baseVersionId };
  const comparison = reviewProgramDocuments(historical, comparableCurrent, 0, {
    exercises: Object.fromEntries(exerciseRows.map((exercise) => [exercise.id, {
      name: exercise.name,
      primaryMuscles: exercise.primaryMuscles,
    }])),
    basePublicationPreflight: publicationPreflightByVersion.get(parsed.data) ?? null,
    nextPublicationPreflight:
      publicationPreflightByVersion.get(current.baseVersionId) ?? null,
  });
  return sensitiveJson({ status: "compared", comparison });
}
