import { z } from "zod";
import { getDb } from "@/db";
import { sensitiveResponse } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { logServerEvent } from "@/lib/server-log";
import { readVerifiedDataSnapshot } from "@/services/snapshots";
import { runExpensiveOperation } from "@/services/expensive-operations";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });
  const { id: rawId } = await context.params;
  const parsed = z.string().uuid().safeParse(rawId);
  if (!parsed.success) return sensitiveResponse("Not found", { status: 404 });

  try {
    const db = await getDb();
    const controlled = await runExpensiveOperation(
      db,
      user.id,
      "snapshot",
      () => readVerifiedDataSnapshot(db, user.id, parsed.data)
    );
    if (!controlled.ok) {
      return sensitiveResponse(controlled.reason, {
        status: 429,
        headers: { "Retry-After": String(controlled.retryAfterSeconds) },
      });
    }
    const { plaintext } = controlled.value;
    return sensitiveResponse(Buffer.from(plaintext), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="workout-tracker-snapshot-${parsed.data}.json"`,
      },
    });
  } catch (error) {
    logServerEvent("warn", "snapshot.download_unavailable", {
      userId: user.id,
      snapshotId: parsed.data,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return sensitiveResponse("Verified snapshot is unavailable.", { status: 404 });
  }
}
