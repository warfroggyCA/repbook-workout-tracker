import { isProgramEditorEnabled } from "@/lib/program-editor-feature";

export function isSessionCompilerEnabled() {
  return isProgramEditorEnabled() && process.env.SESSION_COMPILER_ENABLED === "true";
}
