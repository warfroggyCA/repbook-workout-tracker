import { describe, expect, it, vi } from "vitest";
import {
  HEVY_MAX_FILE_BYTES,
  HEVY_HEADERS,
} from "@/services/hevy-import";
import {
  handleHevyStagingRequest,
  HEVY_MAX_MULTIPART_BYTES,
} from "@/services/hevy-staging-route";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function csvFile(type = "text/csv", name = "history.csv") {
  const row = [
    "Route workout",
    "Jun 1, 2026, 6:00 PM",
    "Jun 1, 2026, 7:00 PM",
    "",
    "Bench Press (Barbell)",
    "",
    "",
    0,
    "normal",
    135,
    8,
    "",
    "",
    8,
  ].join(",");
  return new File([[HEVY_HEADERS.join(","), row].join("\n")], name, { type });
}

function uploadRequest(file = csvFile(), timezone = "America/Toronto") {
  const form = new FormData();
  form.set("file", file);
  form.set("timezone", timezone);
  return new Request("http://localhost/api/import/hevy/stage", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: form,
  });
}

describe("Hevy staging route limits", () => {
  it("rejects a declared oversized request before parsing form data or touching the database", async () => {
    const getDb = vi.fn();
    const stage = vi.fn();
    const request = new Request("http://localhost/api/import/hevy/stage", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
        "content-type": "multipart/form-data; boundary=bounded",
        "content-length": String(HEVY_MAX_MULTIPART_BYTES + 1),
      },
      body: "x",
    });
    const response = await handleHevyStagingRequest(request, {
      getUser: async () => ({ id: USER_ID }),
      getDb,
      stage,
    });
    expect(response.status).toBe(413);
    expect(getDb).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("validates media type, filename, and timezone before staging", async () => {
    const getDb = vi.fn();
    const stage = vi.fn();
    for (const [request, status] of [
      [uploadRequest(csvFile("application/json")), 415],
      [uploadRequest(csvFile("text/csv", "history.txt")), 400],
      [uploadRequest(csvFile(), "Not/A_Timezone"), 400],
    ] as const) {
      const response = await handleHevyStagingRequest(request, {
        getUser: async () => ({ id: USER_ID }),
        getDb,
        stage,
      });
      expect(response.status).toBe(status);
    }
    expect(getDb).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it("rejects a file larger than the raw CSV limit even inside a valid multipart request", async () => {
    const getDb = vi.fn();
    const stage = vi.fn();
    const file = new File(
      [new Uint8Array(HEVY_MAX_FILE_BYTES + 1)],
      "history.csv",
      { type: "text/csv" }
    );
    const response = await handleHevyStagingRequest(uploadRequest(file), {
      getUser: async () => ({ id: USER_ID }),
      getDb,
      stage,
    });
    expect(response.status).toBe(413);
    expect(getDb).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });
});
