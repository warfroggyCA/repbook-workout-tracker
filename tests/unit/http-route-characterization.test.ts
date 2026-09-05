// Freeze guard: pins the reviewed HTTP wire perimeter, sensitive response
// headers, mutation provenance checks, and production browser policy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { buildContentSecurityPolicy } from "@/lib/content-security-policy";
import { validateSameOriginMutation } from "@/lib/route-security";
import {
  parseProgramReviewResponse,
  programEditorResponseJson,
} from "@/lib/program-editor-client";

const mocks = vi.hoisted(() => ({
  getRouteUser: vi.fn<
    () => Promise<{
      id: string;
      profile: { coachingPrefs: Record<string, never> };
    } | null>
  >(async () => ({
      id: "user-1",
      profile: { coachingPrefs: {} },
    })),
  getDb: vi.fn(async () => ({})),
  buildSetsCsv: vi.fn(async () => "date,exercise\n"),
  buildPainFatigueCsv: vi.fn(async () => "date,pain\n"),
  buildActivitiesCsv: vi.fn(async () => "date,activity\n"),
  buildLiveCoachCsv: vi.fn(async () => "date,message\n"),
  buildJsonBackup: vi.fn(async () => ({ schemaVersion: "test" })),
  buildTrainingDigest: vi.fn(async () => ({
    weeks: 4,
    range: { untilLocalDate: "2026-03-31" },
    reporting: { evidenceRevision: "7" },
  })),
  buildLlmTrainingSource: vi.fn(async () => ({
    schemaVersion: "llm-training-source/1",
    evidenceRevision: "7",
    workoutSessions: [],
  })),
  renderCoachingBrief: vi.fn(() => "# Coaching brief"),
  recordExport: vi.fn(async () => undefined),
  sinceDate: vi.fn((weeks: number | null) =>
    weeks == null ? null : new Date(0)
  ),
  stageHevyImport: vi.fn(async () => ({ ok: true })),
  readVerifiedDataSnapshot: vi.fn(async () => ({
    snapshot: { id: "00000000-0000-4000-8000-000000000001", name: "unsafe/name" },
    plaintext: new TextEncoder().encode("{}"),
  })),
  startLiveCoachTurn: vi.fn(),
  discardProgramDraft: vi.fn(),
  getOpenProgramDraft: vi.fn(),
  getOrCreateProgramDraft: vi.fn(),
  saveProgramDraft: vi.fn(),
  reviewProgramDraft: vi.fn(),
  revalidatePath: vi.fn(),
  runExpensiveOperation: vi.fn<
    (
      db: unknown,
      userId: string,
      kind: string,
      work: () => Promise<unknown>
    ) => Promise<
      | { ok: true; value: unknown }
      | { ok: false; reason: string; retryAfterSeconds: number }
    >
  >(
    async (_db: unknown, _userId: string, _kind: string, work: () => Promise<unknown>) => ({
      ok: true as const,
      value: await work(),
    })
  ),
}));

vi.mock("@/lib/route-auth", () => ({ getRouteUser: mocks.getRouteUser }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/services/export", () => ({
  buildSetsCsv: mocks.buildSetsCsv,
  buildPainFatigueCsv: mocks.buildPainFatigueCsv,
  buildActivitiesCsv: mocks.buildActivitiesCsv,
  buildLiveCoachCsv: mocks.buildLiveCoachCsv,
  buildJsonBackup: mocks.buildJsonBackup,
  recordExport: mocks.recordExport,
  sinceDate: mocks.sinceDate,
}));
vi.mock("@/services/digest", () => ({
  buildTrainingDigest: mocks.buildTrainingDigest,
  renderCoachingBrief: mocks.renderCoachingBrief,
}));
vi.mock("@/services/llm-training-source", () => ({
  buildLlmTrainingSource: mocks.buildLlmTrainingSource,
}));
vi.mock("@/services/hevy-staging", () => ({
  stageHevyImport: mocks.stageHevyImport,
}));
vi.mock("@/services/snapshots", () => ({
  readVerifiedDataSnapshot: mocks.readVerifiedDataSnapshot,
}));
vi.mock("@/services/expensive-operations", () => ({
  runExpensiveOperation: mocks.runExpensiveOperation,
}));
vi.mock("@/services/live-coaching", () => ({
  startLiveCoachTurn: mocks.startLiveCoachTurn,
  completeLiveCoachResponse: vi.fn(),
  getLiveCoachResponse: vi.fn(),
  liveCoachFailureReason: vi.fn(),
  markLiveCoachResponseFailed: vi.fn(),
  prepareLiveCoachResponseStream: vi.fn(),
}));
vi.mock("@/lib/program-editor-feature", () => ({
  isProgramEditorEnabled: () => true,
}));
vi.mock("@/services/program-drafts", () => ({
  discardProgramDraft: mocks.discardProgramDraft,
  getOpenProgramDraft: mocks.getOpenProgramDraft,
  getOrCreateProgramDraft: mocks.getOrCreateProgramDraft,
  saveProgramDraft: mocks.saveProgramDraft,
  reviewProgramDraft: mocks.reviewProgramDraft,
}));

import { GET as getCsvExport } from "@/app/api/export/csv/route";
import { GET as getJsonExport } from "@/app/api/export/json/route";
import { GET as getLlmReport } from "@/app/api/export/llm-report/route";
import { GET as getMarkdownExport } from "@/app/api/export/markdown/route";
import { POST as stageHevy } from "@/app/api/import/hevy/stage/route";
import { POST as saveCoachMessage } from "@/app/api/live-coach/messages/route";
import { POST as respondToCoach } from "@/app/api/live-coach/respond/route";
import {
  DELETE as discardProgramDraft,
  PUT as saveProgramDraft,
} from "@/app/api/program/draft/route";
import { POST as reviewProgramDraft } from "@/app/api/program/draft/review/route";
import { GET as downloadSnapshot } from "@/app/api/snapshots/[id]/download/route";

const snapshotId = "00000000-0000-4000-8000-000000000001";

function assertSensitive(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function browserHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("origin", "http://localhost");
  headers.set("sec-fetch-site", "same-origin");
  return headers;
}

function hevyRequest(headers?: HeadersInit) {
  const form = new FormData();
  form.set("timezone", "America/Toronto");
  return new Request("http://localhost/api/import/hevy/stage", {
    method: "POST",
    headers,
    body: form,
  });
}

function messageRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/live-coach/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

function responseRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/live-coach/respond", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

describe("HTTP production perimeter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRouteUser.mockResolvedValue({
      id: "user-1",
      profile: { coachingPrefs: {} },
    });
  });

  it("rejects malformed export parameters before any data work", async () => {
    const requests = [
      "?entity=../../sensitive&weeks=4",
      "?entity=sets&weeks=not-a-number",
      "?entity=sets&weeks=0",
      "?entity=sets&weeks=261",
      "?entity=sets&entity=pain",
      "?entity=sets&unexpected=1",
    ];
    for (const query of requests) {
      const response = await getCsvExport(
        new Request(`http://localhost/api/export/csv${query}`)
      );
      expect(response.status).toBe(400);
      assertSensitive(response);
    }
    expect(mocks.buildSetsCsv).not.toHaveBeenCalled();
    expect(mocks.recordExport).not.toHaveBeenCalled();
  });

  it("uses finite export kinds, bounded ranges, and server-owned filenames", async () => {
    const response = await getCsvExport(
      new Request("http://localhost/api/export/csv?entity=pain&weeks=8")
    );
    expect(response.status).toBe(200);
    expect(mocks.buildPainFatigueCsv).toHaveBeenCalledOnce();
    expect(mocks.sinceDate).toHaveBeenCalledWith(8);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="pain-and-fatigue-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    assertSensitive(response);
  });

  it("builds an all-time private LLM report without a download wrapper", async () => {
    const response = await getLlmReport(new Request("http://localhost/api/export/llm-report"));

    expect(response.status).toBe(200);
    assertSensitive(response);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toBeNull();
    const body = await response.text();
    expect(body).toContain("# Repbook training record");
    expect(body).toContain("<repbook-retained-source-records>");
    expect(mocks.buildTrainingDigest).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      null,
      expect.any(Date),
    );
    expect(mocks.buildLlmTrainingSource).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.any(Date),
    );
    const digestCall = mocks.buildTrainingDigest.mock.calls[0] as unknown as [
      unknown,
      string,
      null,
      Date,
    ];
    const sourceCall = mocks.buildLlmTrainingSource.mock.calls[0] as unknown as [
      unknown,
      string,
      Date,
    ];
    expect(sourceCall[2]).toBe(digestCall[3]);
    expect(mocks.recordExport).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "markdown",
      { range: "all", purpose: "llm_ready_training_report" },
    );
  });

  it("downloads the entire complete report with a byte length and a safe filename", async () => {
    const response = await getLlmReport(new Request("http://localhost/api/export/llm-report?download=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="repbook-complete-report-\d{4}-\d{2}-\d{2}\.md"$/);
    const text = await response.text();
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(text, "utf8"));
    expect(text).toContain("Complete retained source records");
    assertSensitive(response);
  });

  it("returns a recoverable private failure without internal report errors", async () => {
    mocks.buildTrainingDigest.mockRejectedValueOnce(new Error("private internal detail"));
    const response = await getLlmReport(new Request("http://localhost/api/export/llm-report"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("The complete report could not be prepared. Try again.");
    assertSensitive(response);
    expect(mocks.recordExport).not.toHaveBeenCalled();
  });

  it("rebuilds the complete report when its two evidence views do not match", async () => {
    mocks.buildLlmTrainingSource.mockResolvedValueOnce({
      schemaVersion: "llm-training-source/1",
      evidenceRevision: "6",
      workoutSessions: [],
    });

    const response = await getLlmReport(new Request("http://localhost/api/export/llm-report"));

    expect(response.status).toBe(200);
    expect(mocks.buildTrainingDigest).toHaveBeenCalledTimes(2);
    expect(mocks.buildLlmTrainingSource).toHaveBeenCalledTimes(2);
    expect(mocks.recordExport).toHaveBeenCalledOnce();
  });

  it("returns a bounded retry response when an export is already running", async () => {
    mocks.runExpensiveOperation.mockResolvedValueOnce({
      ok: false,
      reason: "A download was just prepared for this account. Wait briefly and try again.",
      retryAfterSeconds: 5,
    });
    const response = await getCsvExport(
      new Request("http://localhost/api/export/csv?entity=sets&weeks=4")
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    assertSensitive(response);
    expect(mocks.buildSetsCsv).not.toHaveBeenCalled();
  });

  it("marks every sensitive export and snapshot response private and non-sniffable", async () => {
    const responses = await Promise.all([
      getCsvExport(new Request("http://localhost/api/export/csv")),
      getJsonExport(),
      getMarkdownExport(
        new Request("http://localhost/api/export/markdown?weeks=4&download=1")
      ),
      getLlmReport(new Request("http://localhost/api/export/llm-report")),
      downloadSnapshot(new Request("http://localhost"), {
        params: Promise.resolve({ id: snapshotId }),
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      assertSensitive(response);
    }
    expect(responses[4].headers.get("content-disposition")).toBe(
      `attachment; filename="workout-tracker-snapshot-${snapshotId}.json"`
    );
    expect(responses[2].headers.get("content-disposition")).toBe(
      'attachment; filename="repbook-training-brief-2026-03-31.md"'
    );
    expect(responses[3].headers.get("content-disposition")).toBeNull();
  });

  it("rejects every mutation route when browser provenance is missing or cross-site", async () => {
    const calls = [stageHevy, saveCoachMessage, respondToCoach] as const;
    const factories = [hevyRequest, messageRequest, responseRequest] as const;
    for (let index = 0; index < calls.length; index += 1) {
      const missing = await calls[index](factories[index]());
      expect(missing.status).toBe(403);
      assertSensitive(missing);

      const crossSite = await calls[index](
        factories[index]({
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        })
      );
      expect(crossSite.status).toBe(403);
      assertSensitive(crossSite);
    }
    expect(mocks.getRouteUser).not.toHaveBeenCalled();
  });

  it("accepts same-origin provenance and then applies each route's validation", async () => {
    const responses = await Promise.all([
      stageHevy(hevyRequest(browserHeaders())),
      saveCoachMessage(messageRequest(browserHeaders())),
      respondToCoach(responseRequest(browserHeaders())),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
    responses.forEach(assertSensitive);
  });

  it("rejects oversized Program draft saves and discards before database work", async () => {
    for (const [method, route] of [
      ["PUT", saveProgramDraft],
      ["DELETE", discardProgramDraft],
    ] as const) {
      const response = await route(
        new Request("http://localhost/api/program/draft", {
          method,
          headers: browserHeaders({
            "content-length": String(4 * 1024 * 1024 + 1),
            "content-type": "application/json",
          }),
          body: "{}",
        })
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        ok: false,
        reason: "The Program draft request is too large.",
      });
      assertSensitive(response);
    }

    const streamedResponse = await saveProgramDraft(
      new Request("http://localhost/api/program/draft", {
        method: "PUT",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );
    expect(streamedResponse.status).toBe(413);
    expect(await streamedResponse.json()).toEqual({
      ok: false,
      reason: "The Program draft request is too large.",
    });
    assertSensitive(streamedResponse);

    expect(mocks.getRouteUser).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.saveProgramDraft).not.toHaveBeenCalled();
    expect(mocks.discardProgramDraft).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "publishable" as const,
      hash: "a".repeat(64),
      blockingErrors: [] as [],
    },
    {
      status: "blocked" as const,
      hash: null,
      blockingErrors: ["The selected equipment cannot execute this exercise."],
    },
  ])("preserves $status Program review evidence through the real route/client boundary", async ({
    status,
    hash,
    blockingErrors,
  }) => {
    const review = {
      status,
      hash,
      reviewedRevision: 4,
      changes: [],
      programUpdates: [],
      blockingErrors,
      cautions: [],
      preflight: null,
      recommendationRevision: 0,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 3,
        weeklySetsAfter: 3,
        durationBefore: [],
        durationAfter: [],
        muscleSetsBefore: {},
        muscleSetsAfter: {},
      },
    };
    mocks.reviewProgramDraft.mockResolvedValue(review);
    const response = await reviewProgramDraft(
      new Request("http://localhost/api/program/draft/review", {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          draftId: "00000000-0000-4000-8000-000000000010",
          expectedRevision: 4,
        }),
      }),
    );
    assertSensitive(response);
    const parsed = parseProgramReviewResponse(
      await programEditorResponseJson(response),
    );
    expect(parsed).toEqual(review);
    if (status === "blocked") {
      expect(parsed.blockingErrors).toEqual([
        "The selected equipment cannot execute this exercise.",
      ]);
    }
  });

  it("validates exact forwarded origin and rejects malformed or same-site origins", () => {
    const forwarded = new Request("http://internal:3000/api/live-coach/messages", {
      method: "POST",
      headers: {
        origin: "https://workouts.example",
        host: "internal:3000",
        "x-forwarded-host": "workouts.example",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(validateSameOriginMutation(forwarded)).toEqual({ ok: true });

    for (const headers of [
      { origin: "::::", "sec-fetch-site": "same-origin" },
      { origin: "http://localhost", "sec-fetch-site": "same-site" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    ]) {
      expect(
        validateSameOriginMutation(
          new Request("http://localhost/api/live-coach/messages", {
            method: "POST",
            headers,
          })
        ).ok
      ).toBe(false);
    }
  });

  it("returns unauthorized before sensitive work when a session is absent or revoked", async () => {
    mocks.getRouteUser.mockResolvedValue(null);
    const responses = await Promise.all([
      getCsvExport(new Request("http://localhost/api/export/csv")),
      getJsonExport(),
      stageHevy(hevyRequest(browserHeaders())),
      saveCoachMessage(messageRequest(browserHeaders())),
      respondToCoach(responseRequest(browserHeaders())),
      downloadSnapshot(new Request("http://localhost"), {
        params: Promise.resolve({ id: snapshotId }),
      }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
    responses.forEach(assertSensitive);
    expect(mocks.buildSetsCsv).not.toHaveBeenCalled();
    expect(mocks.buildJsonBackup).not.toHaveBeenCalled();
    expect(mocks.readVerifiedDataSnapshot).not.toHaveBeenCalled();
  });

  it("defines a centralized enforced browser security policy", async () => {
    const entries = await nextConfig.headers!();
    const headers = new Map(entries[0].headers.map(({ key, value }) => [key, value]));
    expect(headers.has("Content-Security-Policy")).toBe(false);
    expect(headers.has("Content-Security-Policy-Report-Only")).toBe(false);
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Permissions-Policy")).toContain("microphone=(self)");
    const policy = buildContentSecurityPolicy("test-nonce", "production");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain(
      "frame-ancestors 'none'"
    );
  });
});
