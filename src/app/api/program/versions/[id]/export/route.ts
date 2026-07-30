import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveResponse } from "@/lib/http-security";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getRouteUser } from "@/lib/route-auth";
import {
  getOwnedProgramVersionDocument,
  listProgramVersionHistory,
} from "@/services/program-documents";
import { hashProgramDocument } from "@/services/program-document-hash";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isProgramEditorEnabled()) return sensitiveResponse("Not found", { status: 404 });
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });
  const parsed = z.string().uuid().safeParse((await context.params).id);
  if (!parsed.success) return sensitiveResponse("Not found", { status: 404 });
  const db = await getDb();
  const document = await getOwnedProgramVersionDocument(db, user.id, parsed.data);
  if (!document) return sensitiveResponse("Not found", { status: 404 });
  const history = await listProgramVersionHistory(db, user.id, document.programId);
  const version = history.find((entry) => entry.id === parsed.data);
  if (!version) return sensitiveResponse("Not found", { status: 404 });
  const body = {
    format: "workout-tracker-program-version",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    privacy: "Contains only this Program version and its activation metadata.",
    version: {
      ...version,
      documentSchemaVersion: document.schemaVersion,
      documentHash: hashProgramDocument(document),
    },
    document,
  };
  return sensitiveResponse(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="workout-tracker-program-v${version.versionNo}.json"`,
    },
  });
}
