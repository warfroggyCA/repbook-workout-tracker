import "server-only";

/**
 * Emergency rollback switch for Program paste import. Existing published
 * Programs still need the anchor-aware runtime even while new imports are off.
 */
export function isProgramTextImportEnabled() {
  return process.env.PROGRAM_TEXT_IMPORT_ENABLED !== "false";
}
