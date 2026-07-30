import type { ProgramDocument, StoredProgramDocument } from "@/lib/program-document";
import {
  normalizeProgramDocumentLoads,
  normalizeStoredProgramDocumentLoads,
  programDocumentSchema,
  storedProgramDocumentSchema,
} from "@/lib/program-document";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

export function normalizeProgramDocument(value: unknown): ProgramDocument {
  return normalizeProgramDocumentLoads(programDocumentSchema.parse(value));
}

export function hashProgramDocument(value: unknown): string {
  const document = normalizeStoredProgramDocumentLoads(
    storedProgramDocumentSchema.parse(value),
  );
  return sha256Hex(Buffer.from(canonicalJson(document), "utf8"));
}

export function hashLegacyProgramDocument(value: unknown): string {
  const document = storedProgramDocumentSchema.parse(value);
  return sha256Hex(Buffer.from(canonicalJson(document), "utf8"));
}

export function canonicalizeProgramDraftIdentity(
  value: unknown,
  storedHash: unknown
): {
  document: StoredProgramDocument;
  contentHash: string;
  changed: boolean;
} {
  const legacyHash = hashLegacyProgramDocument(value);
  const document = normalizeStoredProgramDocumentLoads(
    storedProgramDocumentSchema.parse(value),
  );
  const contentHash = hashProgramDocument(document);
  if (storedHash !== legacyHash && storedHash !== contentHash) {
    throw new Error("Program draft checksum does not match its document.");
  }
  return {
    document,
    contentHash,
    changed: legacyHash !== contentHash || storedHash !== contentHash,
  };
}
