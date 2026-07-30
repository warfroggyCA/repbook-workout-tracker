import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  startWorkoutSession: vi.fn(),
  findOwnedActiveWorkout: vi.fn(),
  logServerEvent: vi.fn(),
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
vi.mock("@/lib/server-log", () => ({ logServerEvent: mocks.logServerEvent }));
vi.mock("@/services/session-lifecycle", () => ({
  abandonWorkoutSession: vi.fn(),
  completeWorkoutSession: vi.fn(),
  logWorkoutPain: vi.fn(),
  logWorkoutSet: vi.fn(),
  mutateWorkoutOccurrence: vi.fn(),
  startWorkoutSession: mocks.startWorkoutSession,
  findOwnedActiveWorkout: mocks.findOwnedActiveWorkout,
  IncompleteWorkoutCreationError: class extends Error {},
  StaleWorkoutTemplateError: class extends Error {},
}));

import { startSession } from "@/app/actions/sessions";
import {
  IncompleteWorkoutCreationError,
  StaleWorkoutTemplateError,
} from "@/services/session-lifecycle";

const templateId = "03f2ae60-94aa-4ed3-b668-5b3d6a1f8143";

function startForm() {
  const form = new FormData();
  form.set("timezone", "America/Toronto");
  return form;
}

describe("startSession route freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWorkoutSession.mockResolvedValue({
      sessionId: "7c18bb2f-26d8-492f-8dbe-af4c57abef97",
    });
    mocks.findOwnedActiveWorkout.mockResolvedValue(undefined);
  });

  it("invalidates Today before redirecting so browser Back sees the active workout", async () => {
    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
    expect(mocks.revalidatePath.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redirect.mock.invocationCallOrder[0],
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/session/7c18bb2f-26d8-492f-8dbe-af4c57abef97",
      "push",
    );
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

  it("resumes the active workout when an ambiguous failure committed before responding", async () => {
    const activeId = "5dfed613-5c19-4c6a-bd2a-1b04c718b825";
    mocks.startWorkoutSession.mockRejectedValueOnce(new Error("response lost"));
    mocks.findOwnedActiveWorkout.mockResolvedValueOnce({ id: activeId });

    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/today");
    expect(mocks.redirect).toHaveBeenCalledWith(`/session/${activeId}`, "push");
  });

  it("states uncertainty when active-workout reconciliation also fails", async () => {
    const sensitive = new Error("reconciliation detail");
    sensitive.name = "private user text";
    mocks.startWorkoutSession.mockRejectedValueOnce(new Error("response lost"));
    mocks.findOwnedActiveWorkout.mockRejectedValueOnce(sensitive);

    await expect(
      startSession(templateId, { status: "idle" }, startForm()),
    ).resolves.toMatchObject({
      status: "error",
      code: "status_unknown",
      workoutCreated: null,
      message: expect.stringContaining("could not confirm whether"),
    });
    expect(JSON.stringify(mocks.logServerEvent.mock.calls)).not.toContain(
      "private user text",
    );
  });

  it("logs only safe identifiers and a category for an unexpected creation failure", async () => {
    mocks.startWorkoutSession.mockRejectedValueOnce(
      new Error("user note text must not reach logs"),
    );

    await startSession(templateId, { status: "idle" }, startForm());

    expect(mocks.logServerEvent).toHaveBeenCalledWith(
      "error",
      "session.start_failed",
      expect.objectContaining({
        templateId,
        category: "unexpected_creation_failure",
        errorName: "Error",
      }),
    );
    expect(JSON.stringify(mocks.logServerEvent.mock.calls)).not.toContain(
      "user note text",
    );
  });
});
