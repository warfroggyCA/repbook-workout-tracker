import { z } from "zod";
import { getDb } from "@/db";
import {
  EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES,
  parseExternalAnalysisRawInput,
  validateExternalAnalysisResponse,
} from "@/lib/external-analysis-response";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { getExternalAnalysisResponseBinding } from "@/services/external-analysis-validation";

const packageIdEnvelopeSchema = z
  .object({
    analysisPackage: z.object({ packageId: z.string().uuid() }).passthrough(),
  })
  .passthrough();

export async function POST(request: Request) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await getRouteUser();
  if (!user) return sensitiveJson({ error: "Unauthorized" }, { status: 401 });

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRequestBody(
      request,
      EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return sensitiveJson(
        { error: "The response is larger than the supported 256 KiB limit." },
        { status: 413 },
      );
    }
    return sensitiveJson({ error: "The response could not be read." }, { status: 400 });
  }

  const parsedInput = parseExternalAnalysisRawInput(
    bytes,
    request.headers.get("content-type"),
  );
  if (!parsedInput.ok) {
    return sensitiveJson(
      { error: parsedInput.message, code: parsedInput.code },
      { status: parsedInput.code === "invalid_media_type" ? 415 : 400 },
    );
  }
  const packageEnvelope = packageIdEnvelopeSchema.safeParse(parsedInput.value);
  if (!packageEnvelope.success) {
    return sensitiveJson(
      { error: "The response does not identify a valid analysis package." },
      { status: 422 },
    );
  }

  const manifest = await getExternalAnalysisResponseBinding(
    await getDb(),
    user.id,
    packageEnvelope.data.analysisPackage.packageId,
  );
  if (!manifest.ok) {
    const responses = {
      not_found: {
        status: 404,
        error: "The matching owner-scoped package manifest was not found.",
      },
      expired: {
        status: 410,
        error: "The matching package manifest has expired. Prepare a new package and regenerate the response.",
      },
      stale_program: {
        status: 409,
        error: "The current Program changed after this package was prepared. Prepare a new package before using the response.",
      },
      stale_evidence: {
        status: 409,
        error: "Bound evidence changed after this package was prepared. Prepare a new package before using the response.",
      },
      invalid_manifest: {
        status: 409,
        error: "The retained package manifest cannot safely validate this response.",
      },
    } as const;
    const response = responses[manifest.reason];
    return sensitiveJson(
      { error: response.error, code: manifest.reason },
      { status: response.status },
    );
  }

  const validation = validateExternalAnalysisResponse(
    parsedInput.value,
    manifest.binding,
  );
  if (!validation.ok) {
    return sensitiveJson(
      {
        error: "The response failed the closed Repbook validation contract.",
        code: "validation_failed",
        issues: validation.issues.slice(0, 50),
      },
      { status: 422 },
    );
  }

  return sensitiveJson({
    preview: validation.response,
    effectSummary: validation.response.proposedActions.map((proposal) => ({
      proposalId: proposal.id,
      type: proposal.effect.type,
      scope: proposal.effect.scope,
      targetKind: proposal.effect.target.kind,
    })),
    retained: false,
    imported: false,
  });
}
