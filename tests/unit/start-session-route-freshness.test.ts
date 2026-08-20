import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  startWorkoutSession: vi.fn(),
  findOwnedWorkoutByStartRequest: vi.fn(),
  findOwnedActiveWorkout: vi.fn(),
  buildWorkoutStartRequestHash: vi.fn(() => "canonical-start-hash"),
  logDiagnosticEvent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  RedirectType: { push: "push", replace: "replace" },
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => ({ id: crypto.randomUUID() })),
}));
vi.mock("@/lib/user-id-cache", () => ({
  getCurrentUserIdFast: vi.fn(),
  refreshCurrentUserIdFast: vi.fn(),
}));
vi.mock("@/lib/server-log", () => ({
  categorizeDiagnosticError: vi.fn((_error, fallback) => fallback),
  logDiagnosticEvent: mocks.logDiagnosticEvent,
}));
vi.mock("@/services/session-lifecycle", () => ({
  abandonWorkoutSession: vi.fn(),
  completeWorkoutSession: vi.fn(),
  logWorkoutPain: vi.fn(),
  logWorkoutSet: vi.fn(),
  mutateWorkoutOccurrence: vi.fn(),
  startWorkoutSession: mocks.startWorkoutSession,
  findOwnedWorkoutByStartRequest: mocks.findOwnedWorkoutByStartRequest,
  findOwnedActiveWorkout: mocks.findOwnedActiveWorkout,
  buildWorkoutStartRequestHash: mocks.buildWorkoutStartRequestHash,
  IncompleteWorkoutCreationError: class extends Error {},
  StaleWorkoutTemplateError: class extends Error {},
}));

import { startSession } from "@/app/actions/sessions";
import {
  IncompleteWorkoutCreationError,
  StaleWorkoutTemplateError,
} from "@/services/session-lifecycle";
import { retainedWorkoutStartRequestKey } from "@/lib/workout-start";

const templateId = "03f2ae60-94aa-4ed3-b668-5b3d6a1f8143";
const startRequestKey = "da8bd7af-77e3-4c78-8be6-5a2c76fccd5b";

function startForm() {
  const form = new FormData();
  form.set("timezone", "America/Toronto");
  form.set("startRequestKey", startRequestKey);
  return form;
}

function scheduledStartForm() {
  const form = startForm();
  form.set("scheduledProgramEventId", "a9a8fcd0-2513-4ff3-907a-d44ac72f4dc9");
  form.set("expectedEventRevision", "2");
  form.set("programScheduleVersionId", "63d06aa5-534e-4e6f-8b63-d888a658ab72");
  form.set("programScheduleVersionHash", "a".repeat(64));
  return form;
}

describe("startSession route freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWorkoutSession.mockResolvedValue({
      outcome: "created",
      sessionId: "7c18bb2f-26d8-492f-8dbe-af4c57abef97",
      existing: false,
    });
    mocks.findOwnedWorkoutByStartRequest.mockResolvedValue(undefined);
    mocks.findOwnedActiveWorkout.mockResolvedValue(undefined);
  });

  it("retains the submitted server-issued identity across an error rerender", () => {
    expect(retainedWorkoutStartRequestKey(crypto.randomUUID(), {
      status: "error",
      code: "not_created",
      message: "Try again",
      workoutCreated: false,
      startRequestKey,
    })).toBe(startRequestKey);
  });

  it("invalidates Today before redirecting so browser Back sees the active workout", async () => {
    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.buildWorkoutStartRequestHash).toHaveBeenCalledWith(
      expect.objectContaining({ includeWarmups: false }),
    );
    expect(mocks.startWorkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      templateId,
      undefined,
      expect.objectContaining({ includeWarmups: false }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
    expect(mocks.revalidatePath.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redirect.mock.invocationCallOrder[0],
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/session/7c18bb2f-26d8-492f-8dbe-af4c57abef97",
      "push",
    );
  });

  it("binds an explicit warm-up opt-in into the Start identity", async () => {
    const form = startForm();
    form.set("includeWarmups", "true");

    await startSession(templateId, { status: "idle" }, form);

    expect(mocks.buildWorkoutStartRequestHash).toHaveBeenCalledWith(
      expect.objectContaining({ includeWarmups: true }),
    );
    expect(mocks.startWorkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      templateId,
      undefined,
      expect.objectContaining({ includeWarmups: true }),
    );
  });

  it("rejects an unsupported warm-up selection before creating a workout", async () => {
    const form = startForm();
    form.set("includeWarmups", "sometimes");

    await expect(
      startSession(templateId, { status: "idle" }, form),
    ).resolves.toMatchObject({
      status: "error",
      code: "not_created",
      workoutCreated: false,
    });
    expect(mocks.startWorkoutSession).not.toHaveBeenCalled();
  });

  it("binds the exact scheduled occurrence into the Start identity", async () => {
    await startSession(templateId, { status: "idle" }, scheduledStartForm());

    const scheduledStart = {
      scheduledProgramEventId: "a9a8fcd0-2513-4ff3-907a-d44ac72f4dc9",
      expectedEventRevision: 2,
      programScheduleVersionId: "63d06aa5-534e-4e6f-8b63-d888a658ab72",
      programScheduleVersionHash: "a".repeat(64),
    };
    expect(mocks.buildWorkoutStartRequestHash).toHaveBeenCalledWith(
      expect.objectContaining({ templateId, scheduledStart }),
    );
    expect(mocks.startWorkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      templateId,
      undefined,
      expect.objectContaining({ scheduledStart }),
    );
  });

  it("rejects a partial scheduled Start identity before creating a workout", async () => {
    const form = startForm();
    form.set("scheduledProgramEventId", "a9a8fcd0-2513-4ff3-907a-d44ac72f4dc9");
    await expect(startSession(templateId, { status: "idle" }, form)).resolves.toMatchObject({
      status: "error",
      code: "not_created",
      workoutCreated: false,
    });
    expect(mocks.startWorkoutSession).not.toHaveBeenCalled();
  });

  it.each([
    [new IncompleteWorkoutCreationError(), "not_created", "nothing was kept"],
    [new Error("private database detail"), "not_created", "No workout was created"],
  ])("returns an inline recovery result without navigating for %s", async (
    error,
    code,
    message,
  ) => {
    mocks.startWorkoutSession.mockRejectedValueOnce(error);

    await expect(
      startSession(templateId, { status: "idle" }, startForm()),
    ).resolves.toMatchObject({
      status: "error",
      code,
      message: expect.stringContaining(message),
      workoutCreated: false,
      startRequestKey,
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refreshes Today onto the current Program after a stale start", async () => {
    mocks.startWorkoutSession.mockRejectedValueOnce(new StaleWorkoutTemplateError());

    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/today?program=updated",
      "replace",
    );
    expect(mocks.findOwnedActiveWorkout).not.toHaveBeenCalled();
  });

  it("resumes only the exact requested workout after an ambiguous response", async () => {
    const exactId = "5dfed613-5c19-4c6a-bd2a-1b04c718b825";
    mocks.startWorkoutSession.mockRejectedValueOnce(new Error("response lost"));
    mocks.findOwnedWorkoutByStartRequest.mockResolvedValueOnce({
      id: exactId,
      startRequestHash: "canonical-start-hash",
    });

    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
    expect(mocks.redirect).toHaveBeenCalledWith(`/session/${exactId}`, "push");
    expect(mocks.findOwnedActiveWorkout).not.toHaveBeenCalled();
  });

  it("states uncertainty when exact-request reconciliation fails", async () => {
    const sensitive = new Error("reconciliation detail");
    sensitive.name = "private user text";
    mocks.startWorkoutSession.mockRejectedValueOnce(new Error("response lost"));
    mocks.findOwnedWorkoutByStartRequest.mockRejectedValueOnce(sensitive);

    await expect(
      startSession(templateId, { status: "idle" }, startForm()),
    ).resolves.toMatchObject({
      status: "error",
      code: "status_unknown",
      workoutCreated: null,
      startRequestKey,
      message: expect.stringContaining("could not confirm whether"),
    });
    expect(JSON.stringify(mocks.logDiagnosticEvent.mock.calls)).not.toContain(
      "private user text",
    );
  });

  it("returns a same-key conflict inline without revalidating the form", async () => {
    mocks.startWorkoutSession.mockResolvedValueOnce({
      outcome: "request_conflict",
      sessionId: crypto.randomUUID(),
      existing: true,
    });

    await expect(
      startSession(templateId, { status: "idle" }, startForm()),
    ).resolves.toMatchObject({
      status: "error",
      code: "request_conflict",
      startRequestKey,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("logs only closed categories for an unexpected creation failure", async () => {
    mocks.startWorkoutSession.mockRejectedValueOnce(
      new Error("user note text must not reach logs"),
    );

    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.logDiagnosticEvent).toHaveBeenCalledWith(
      "session.start_failed",
      {
        failure: "unexpected_creation_failure",
        errorCategory: "persistence",
      },
    );
    expect(JSON.stringify(mocks.logDiagnosticEvent.mock.calls)).not.toContain(
      "user note text",
    );
  });
});
