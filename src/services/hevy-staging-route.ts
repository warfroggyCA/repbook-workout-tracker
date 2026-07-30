import type { Db } from "@/db";
import {
  HEVY_MAX_FILE_BYTES,
} from "@/services/hevy-import";
import {
  stageHevyImport,
  validateHevyUploadMetadata,
} from "@/services/hevy-staging";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { sensitiveJson } from "@/lib/http-security";
import { sameOriginMutationFailure } from "@/lib/route-security";
import { runExpensiveOperation } from "@/services/expensive-operations";

export const HEVY_MAX_MULTIPART_BYTES = HEVY_MAX_FILE_BYTES + 256 * 1024;

const ALLOWED_CSV_MEDIA_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "",
]);

export type HevyStagingRouteDependencies = {
  getUser: () => Promise<{ id: string } | null>;
  getDb: () => Promise<Db>;
  stage?: typeof stageHevyImport;
};

function failure(reason: string, status: number) {
  return sensitiveJson({ ok: false, reason }, { status });
}

export async function handleHevyStagingRequest(
  request: Request,
  dependencies: HevyStagingRouteDependencies
) {
  const forbidden = sameOriginMutationFailure(request);
  if (forbidden) return forbidden;

  const user = await dependencies.getUser();
  if (!user) return failure("Unauthorized", 401);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return failure("Hevy history must be uploaded as multipart form data.", 415);
  }

  let form: FormData;
  try {
    const body = await readBoundedRequestBody(request, HEVY_MAX_MULTIPART_BYTES);
    const bounded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(body).buffer,
    });
    form = await bounded.formData();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return failure("The maximum import size is 20 MB.", 413);
    }
    return failure("The Hevy upload could not be read.", 400);
  }

  const files = form.getAll("file");
  const file = files[0];
  const timezone = String(form.get("timezone") ?? "").trim();
  if (files.length !== 1 || !(file instanceof File)) {
    return failure("Choose one Hevy CSV file.", 400);
  }
  if (file.size > HEVY_MAX_FILE_BYTES) {
    return failure("The maximum import size is 20 MB.", 413);
  }
  const normalizedMediaType = file.type.toLowerCase().split(";", 1)[0].trim();
  if (!ALLOWED_CSV_MEDIA_TYPES.has(normalizedMediaType)) {
    return failure("Hevy history must be a CSV text file.", 415);
  }
  try {
    validateHevyUploadMetadata({ timezone, originalFilename: file.name });
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Invalid upload.", 400);
  }

  const db = await dependencies.getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "import",
    async () =>
      (dependencies.stage ?? stageHevyImport)(db, user.id, {
        csv: await file.text(),
        timezone,
        originalFilename: file.name,
      })
  );
  if (!controlled.ok) {
    return sensitiveJson(
      { ok: false, reason: controlled.reason },
      {
        status: 429,
        headers: { "Retry-After": String(controlled.retryAfterSeconds) },
      }
    );
  }
  const result = controlled.value;
  if (!result.ok) return failure(result.reason, result.status);
  return sensitiveJson(result);
}
