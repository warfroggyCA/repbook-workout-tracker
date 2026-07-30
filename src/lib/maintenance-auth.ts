import { timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";

export function maintenanceAuthorized(request: Request):
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string } {
  const secret = optionalEnv("MAINTENANCE_SECRET");
  if (!secret) {
    return { ok: false, status: 503, reason: "Maintenance is not configured." };
  }
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { ok: false, status: 401, reason: "Unauthorized" };
  }
  return { ok: true };
}
