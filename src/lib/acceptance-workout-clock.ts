import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";

type ClockOperation = "start" | "finish";

type AcceptanceClockEnvironment = Partial<
  Record<
    | "BA_FIXTURE_MODE"
    | "BA_CALENDAR_MODE"
    | "BA_ACCEPTANCE_START_AT"
    | "BA_ACCEPTANCE_FINISH_AT",
    string
  >
>;

export function acceptanceWorkoutNow(
  operation: ClockOperation,
  environment: AcceptanceClockEnvironment = process.env as AcceptanceClockEnvironment,
  disposableRuntime = isDisposableAcceptanceRuntime(),
): (() => Date) | undefined {
  const start = environment.BA_ACCEPTANCE_START_AT?.trim();
  const finish = environment.BA_ACCEPTANCE_FINISH_AT?.trim();
  if (!start && !finish) return undefined;
  if (
    environment.BA_FIXTURE_MODE !== "1" ||
    environment.BA_CALENDAR_MODE !== "1" ||
    !disposableRuntime
  ) {
    throw new Error(
      "The BA calendar clock requires its explicit disposable fixture runtime.",
    );
  }
  if (!start || !finish) {
    throw new Error("The BA calendar clock requires both start and finish instants.");
  }
  const value = operation === "start" ? start : finish;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(
      `The BA calendar ${operation} instant must be an exact UTC ISO timestamp.`,
    );
  }
  return () => new Date(parsed.getTime());
}
