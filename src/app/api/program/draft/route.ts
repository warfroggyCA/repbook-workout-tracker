import { z } from "zod";
import { getDb } from "@/db";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { sensitiveJson } from "@/lib/http-security";
import { programDocumentV3Schema } from "@/lib/program-document";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import {
  discardProgramDraft,
  getOpenProgramDraft,
  getOrCreateProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Functions reject payloads above 4.5 MB before this route runs. Keep
// the application ceiling below that platform boundary while still leaving
// generous room for real Program drafts at the current supported scale.
const MAX_PROGRAM_DRAFT_REQUEST_BYTES = 4 * 1024 * 1024;

const saveSchema = z.object({
  draftId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  mutationId: z.string().uuid(),
  document: programDocumentV3Schema,
});
const discardSchema = z.object({
  draftId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
});

async function editorUser() {
  if (!isProgramEditorEnabled()) return null;
  return getRouteUser();
}

async function readProgramDraftJson(request: Request) {
  try {
    const bytes = await readBoundedRequestBody(
      request,
      MAX_PROGRAM_DRAFT_REQUEST_BYTES
    );
    return {
      status: "ok" as const,
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? { status: "too-large" as const }
      : { status: "ok" as const, body: null };
  }
}

export async function GET() {
  const user = await editorUser();
  if (!user) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const db = await getDb();
  const state = await getOpenProgramDraft(db, user.id);
  if (!state) return sensitiveJson({ reason: "No open Program draft exists." }, { status: 404 });
  return sensitiveJson({ status: "ok", draft: { ...state.draft, history: state.history } });
}

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  const user = await editorUser();
  if (!user) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const state = await getOrCreateProgramDraft(await getDb(), user.id);
  if (!state) return sensitiveJson({ reason: "No active Program is available to edit." }, { status: 404 });
  return sensitiveJson({ status: "ok", draft: { ...state.draft, history: state.history } });
}

export async function PUT(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  const body = await readProgramDraftJson(request);
  if (body.status === "too-large") {
    return sensitiveJson(
      { ok: false, reason: "The Program draft request is too large." },
      { status: 413 }
    );
  }
  const user = await editorUser();
  if (!user) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const parsed = saveSchema.safeParse(body.body);
  if (!parsed.success) return sensitiveJson({ status: "invalid", errors: ["The Program draft request is invalid."] }, { status: 400 });
  const result = await saveProgramDraft(await getDb(), user.id, parsed.data);
  // A revision conflict is an expected editor state whose payload contains the
  // newer server copy. Keep it readable by the client instead of converting it
  // into a generic transport error.
  return sensitiveJson(result, { status: result.status === "invalid" ? 400 : 200 });
}

export async function DELETE(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;
  const body = await readProgramDraftJson(request);
  if (body.status === "too-large") {
    return sensitiveJson(
      { ok: false, reason: "The Program draft request is too large." },
      { status: 413 }
    );
  }
  const user = await editorUser();
  if (!user) return sensitiveJson({ reason: "Program editing is unavailable." }, { status: 404 });
  const parsed = discardSchema.safeParse(body.body);
  if (!parsed.success) return sensitiveJson({ reason: "The discard request is invalid." }, { status: 400 });
  const discarded = await discardProgramDraft(
    await getDb(),
    user.id,
    parsed.data.draftId,
    parsed.data.expectedRevision
  );
  return discarded.status === "discarded"
    ? sensitiveJson({ status: "discarded" })
    : sensitiveJson({ reason: "The draft changed in another tab. Reload it before discarding." }, { status: 409 });
}
