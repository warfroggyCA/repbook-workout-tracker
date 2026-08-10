import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import {
  liveCoachValidationIssue,
  startLiveCoachTurnSchema,
} from "@/lib/live-coach-validation";
import { startLiveCoachTurn } from "@/services/live-coaching";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) {
    return sensitiveJson(
      {
        ok: false,
        reason: "Sign in again, then retry this saved Coach message.",
      },
      { status: 401 }
    );
  }
  if (!user.profile) {
    return sensitiveJson(
      {
        ok: false,
        reason: "Complete account setup, then retry this saved Coach message.",
      },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    logDiagnosticEvent("live_coach.saved_message_invalid_json", {
      errorCategory: categorizeDiagnosticError(error, "validation"),
    });
    return sensitiveJson(
      { ok: false, reason: "Live Coach received an invalid saved message." },
      { status: 400 }
    );
  }

  const parsed = startLiveCoachTurnSchema.safeParse(body);
  if (!parsed.success) {
    return sensitiveJson(
      { ok: false, reason: liveCoachValidationIssue(parsed.error) },
      { status: 400 }
    );
  }

  try {
    const db = await getDb();
    const result = await startLiveCoachTurn(db, user.id, parsed.data);
    revalidatePath(`/session/${parsed.data.sessionId}`);
    revalidatePath(`/history/${parsed.data.sessionId}`);
    revalidatePath("/coach");
    revalidatePath("/export");
    return sensitiveJson({ ok: true, ...result });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "The workout message could not be reconciled with this saved identity."
    ) {
      return sensitiveJson(
        {
          ok: false,
          reason:
            "This saved message no longer matches the workout. Keep the text, then retry or remove it from the device.",
        },
        { status: 409 }
      );
    }
    return sensitiveJson(
      {
        ok: false,
        reason: "Live Coach could not save this message yet.",
      },
      { status: 503 }
    );
  }
}
