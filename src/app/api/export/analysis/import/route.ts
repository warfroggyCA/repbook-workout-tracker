import { getDb } from "@/db";
import {
  EXTERNAL_ANALYSIS_IMPORT_MAX_BYTES,
  externalAnalysisImportRequestSchema,
} from "@/lib/external-analysis-import";
import { parseExternalAnalysisRawInput } from "@/lib/external-analysis-response";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { importExternalAnalysisSelection } from "@/services/external-analysis-import";

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) return sensitiveJson({ error: "Unauthorized" }, { status: 401 });
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return sensitiveJson({ error: "Use the Repbook JSON import request." }, { status: 415 });
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRequestBody(request, EXTERNAL_ANALYSIS_IMPORT_MAX_BYTES);
  } catch (error) {
    return sensitiveJson(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "The import request is larger than the supported limit."
            : "The import request could not be read.",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }

  const rawInput = parseExternalAnalysisRawInput(bytes, "application/json");
  if (!rawInput.ok) {
    return sensitiveJson({ error: rawInput.message, code: rawInput.code }, { status: 400 });
  }
  const parsed = externalAnalysisImportRequestSchema.safeParse(rawInput.value);
  if (!parsed.success) {
    return sensitiveJson(
      { error: parsed.error.issues[0]?.message ?? "The import selection is invalid." },
      { status: 422 },
    );
  }

  const result = await importExternalAnalysisSelection(
    await getDb(),
    user.id,
    parsed.data,
  );
  if (!result.ok) {
    const status =
      result.reason === "missing_manifest"
        ? 404
        : result.reason === "expired_manifest"
          ? 410
          : result.reason === "stale_program" || result.reason === "conflict"
            ? 409
            : 422;
    return sensitiveJson({ error: result.message, code: result.reason }, { status });
  }
  return sensitiveJson(result);
}
