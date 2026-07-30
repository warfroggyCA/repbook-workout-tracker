import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { reviewProgramDraft } from "@/services/program-drafts";

const schema = z.object({ draftId: z.string().uuid(), expectedRevision: z.number().int().min(1) });

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  if (!isProgramEditorEnabled()) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Sign in again." }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return sensitiveJson({ reason: "The review request is invalid." }, { status: 400 });
  const review = await reviewProgramDraft(await getDb(), user.id, parsed.data.draftId, parsed.data.expectedRevision);
  if (!review) return sensitiveJson({ reason: "The draft changed. Reload it before reviewing." }, { status: 409 });
  return sensitiveJson({ status: "reviewed", review });
}
