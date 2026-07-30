import { createHash } from "node:crypto";

export const RAW_DATA_RETENTION_HOURS = 24;

export function sensitiveTextSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function rawDataExpiresAt(now = new Date()) {
  return new Date(now.getTime() + RAW_DATA_RETENTION_HOURS * 60 * 60 * 1_000);
}
