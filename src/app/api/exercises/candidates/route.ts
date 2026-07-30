import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { searchExtendedExerciseCatalog } from "@/services/extended-exercise-catalog";

export async function GET(request: Request) {
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ ok: false, reason: "Unauthorized" }, { status: 401 });
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  return sensitiveJson({ ok: true, candidates: searchExtendedExerciseCatalog(query) });
}
