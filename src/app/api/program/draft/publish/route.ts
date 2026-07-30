import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import {
  getPublishedProgramDraftReplay,
  publishProgramDraft,
  validateProgramDraftPublication,
} from "@/services/program-publication";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";

const schema = z.object({
  draftId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  if (!isProgramEditorEnabled()) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Sign in again." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return sensitiveJson({ reason: "The activation request is invalid." }, { status: 400 });
  const db = await getDb();
  const replay = await getPublishedProgramDraftReplay(db, user.id, parsed.data);
  if (replay) {
    return sensitiveJson({
      status: "published",
      version: { id: replay.programVersionId, versionNo: replay.versionNo },
    });
  }
  const eligibility = await validateProgramDraftPublication(
    db,
    user.id,
    parsed.data,
  );
  if (!eligibility.ok) {
    return sensitiveJson(
      {
        reason:
          eligibility.reason === "conflict"
            ? "The active Program changed. Reload and review this draft again."
            : "The saved review is no longer current. Create a fresh review before activating.",
      },
      { status: 409 },
    );
  }
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_program_editor_activation",
    "Automatic protection created before activating a reviewed Program draft."
  );
  if (!safety.ok) return sensitiveJson({ reason: `The Program was not changed because its safety snapshot could not be verified: ${safety.reason}` }, { status: 503 });
  const result = await publishProgramDraft(db, user.id, parsed.data);
  if (!result.ok) return sensitiveJson({ reason: result.reason === "conflict" ? "The active Program changed. Reload and review this draft again." : "The reviewed draft is no longer current. Reload it before activating." }, { status: 409 });
  revalidatePath("/program");
  revalidatePath("/program/edit");
  revalidatePath("/today");
  return sensitiveJson({ status: "published", version: { id: result.programVersionId, versionNo: result.versionNo } });
}
