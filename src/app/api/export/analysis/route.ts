import { getDb } from "@/db";
import { analysisPackageRequestSchema } from "@/lib/analysis-package";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { logServerEvent } from "@/lib/server-log";
import {
  AnalysisPackageTooLargeError,
  createAnalysisPackage,
  listAnalysisPackageManifests,
} from "@/services/analysis-package";
import { runExpensiveOperation } from "@/services/expensive-operations";

const MAX_ANALYSIS_PACKAGE_REQUEST_BYTES = 8 * 1024;

export async function GET() {
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  return sensitiveJson({
    manifests: await listAnalysisPackageManifests(db, user.id),
  });
}

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) return sensitiveJson({ error: "Unauthorized" }, { status: 401 });

  let input: unknown;
  try {
    const bytes = await readBoundedRequestBody(
      request,
      MAX_ANALYSIS_PACKAGE_REQUEST_BYTES,
    );
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return sensitiveJson(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "The analysis package request is too large."
            : "Invalid analysis package request",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const parsed = analysisPackageRequestSchema.safeParse(input);
  if (!parsed.success) {
    return sensitiveJson({ error: "Invalid analysis package request" }, { status: 400 });
  }

  const db = await getDb();
  try {
    const controlled = await runExpensiveOperation(
      db,
      user.id,
      "export",
      () => createAnalysisPackage(db, user.id, parsed.data),
    );
    if (!controlled.ok) {
      return sensitiveJson(
        { error: controlled.reason },
        {
          status: 429,
          headers: { "Retry-After": String(controlled.retryAfterSeconds) },
        },
      );
    }
    return sensitiveJson({ package: controlled.value.package });
  } catch (error) {
    if (error instanceof AnalysisPackageTooLargeError) {
      return sensitiveJson({ error: error.message }, { status: 413 });
    }
    logServerEvent("error", "analysis_package.generation_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return sensitiveJson(
      {
        error:
          "The analysis package could not be returned. Check retained manifests before trying again.",
      },
      { status: 500 },
    );
  }
}
