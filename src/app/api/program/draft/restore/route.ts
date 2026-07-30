import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import {
  createRestoreProgramDraft,
  getRestoreProgramDraftReplay,
} from "@/services/program-drafts";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";

const schema = z.object({
  versionId: z.string().uuid(),
  currentDraftId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  mutationId: z.string().uuid(),
});

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  if (!isProgramEditorEnabled()) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Sign in again." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return sensitiveJson({ reason: "The restore request is invalid." }, { status: 400 });
  const db = await getDb();
  const replay = await getRestoreProgramDraftReplay(
    db,
    user.id,
    parsed.data.versionId,
    parsed.data.mutationId
  );
  if (replay) {
    return sensitiveJson({ status: "created", draft: replay });
  }
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_program_restore_draft",
    "Automatic protection created before replacing the open draft with a historical Program version."
  );
  if (!safety.ok) return sensitiveJson({ reason: `The draft was not changed because its safety snapshot could not be verified: ${safety.reason}` }, { status: 503 });
  const result = await createRestoreProgramDraft(db, user.id, parsed.data.versionId, parsed.data);
  if (result.status === "conflict") return sensitiveJson({ reason: "The open draft changed in another tab. Reload it before restoring a version." }, { status: 409 });
  if (result.status !== "created") return sensitiveJson({ reason: "That Program version is no longer available." }, { status: 404 });
  return sensitiveJson({ status: "created", draft: result.draft });
}
