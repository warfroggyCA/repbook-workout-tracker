import "server-only";

export function isProgramEditorEnabled() {
  return process.env.PROGRAM_EDITOR_ENABLED === "true";
}
