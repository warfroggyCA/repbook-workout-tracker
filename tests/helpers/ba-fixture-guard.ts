import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";

export type BaFixtureEnvironment = Partial<
  Record<"AI_FAKE" | "BA_FIXTURE_MODE" | "DATABASE_URL" | "PGLITE_DIR", string>
>;

export function assertBaFixtureEnvironment(
  environment: BaFixtureEnvironment = process.env as BaFixtureEnvironment,
  temporaryRoot = tmpdir(),
): string {
  if (environment.BA_FIXTURE_MODE !== "1") {
    throw new Error("The BA fixture requires explicit BA_FIXTURE_MODE=1.");
  }
  if (environment.AI_FAKE !== "1") {
    throw new Error("The BA fixture requires deterministic AI_FAKE=1.");
  }
  if (environment.DATABASE_URL?.trim()) {
    throw new Error("The BA fixture refuses every non-empty DATABASE_URL.");
  }
  if (!environment.PGLITE_DIR?.trim()) {
    throw new Error("The BA fixture requires a disposable PGLITE_DIR.");
  }

  const root = resolve(temporaryRoot);
  const target = resolve(environment.PGLITE_DIR);
  const fromRoot = relative(root, target);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, fromRoot) !== target
  ) {
    throw new Error("The BA fixture PGLITE_DIR must be inside the operating-system temporary directory.");
  }
  if (!basename(target).startsWith("workout-tracker-fresh-")) {
    throw new Error("The BA fixture requires a freshly created workout-tracker-fresh-* database.");
  }
  return target;
}
