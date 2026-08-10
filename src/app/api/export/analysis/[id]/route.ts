import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { deleteAnalysisPackageManifest } from "@/services/analysis-package";

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/export/analysis/[id]">,
) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) return sensitiveJson({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return sensitiveJson({ error: "Package manifest not found" }, { status: 404 });
  }
  const db = await getDb();
  const deleted = await deleteAnalysisPackageManifest(db, user.id, id);
  return deleted
    ? sensitiveJson({ ok: true })
    : sensitiveJson({ error: "Package manifest not found" }, { status: 404 });
}
