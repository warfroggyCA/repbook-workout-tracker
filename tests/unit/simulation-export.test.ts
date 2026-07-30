import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSimulationExport,
  buildSimulationExportDownload,
  downloadSimulationExport,
  SIMULATION_EXPORT_FILENAME_PREFIX,
  SIMULATION_EXPORT_LABEL,
  SIMULATION_EXPORT_MIME_TYPE,
  SIMULATION_EXPORT_SCHEMA_VERSION,
} from "@/components/simulation/simulation-export";
import { createSimulationWorkspace, type SimulationSourceSnapshot } from "@/lib/workout-simulation";

function sourceSnapshot(): SimulationSourceSnapshot {
  return {
    schemaVersion: 1,
    ownerId: "20000000-0000-4000-8000-000000000001",
    program: { id: "program", versionId: "version", versionNo: 1, name: "Program" },
    sourceDigest: "digest",
    capturedAtISO: "2026-07-22T12:00:00.000Z",
    unit: "lb",
    days: [{ id: "day", name: "Day 1", orderIdx: 0, warmups: [], groups: [], exercises: [] }],
  };
}

function workspace() {
  return createSimulationWorkspace(sourceSnapshot(), {
    createId: () => "export",
    nowISO: "2026-07-22T12:01:00.000Z",
  });
}

describe("simulation export", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is unmistakably labelled and excludes a canonical recovery shape", () => {
    const artifact = buildSimulationExport(workspace());
    expect(artifact).toMatchObject({
      artifactKind: "workout_simulation",
      label: SIMULATION_EXPORT_LABEL,
      schemaVersion: SIMULATION_EXPORT_SCHEMA_VERSION,
    });
    expect(artifact).not.toHaveProperty("tables");
    expect(artifact).not.toHaveProperty("encryptedData");
  });

  it("uses a distinct simulation filename, MIME type, schema, and visible preview", () => {
    const download = buildSimulationExportDownload(workspace());
    const parsed = JSON.parse(download.content) as Record<string, unknown>;

    expect(download.filename).toMatch(/^workout-simulation-sim_workspace_[A-Za-z0-9_-]+\.json$/);
    expect(download.filename.startsWith(SIMULATION_EXPORT_FILENAME_PREFIX)).toBe(true);
    expect(download.mimeType).toBe(SIMULATION_EXPORT_MIME_TYPE);
    expect(download.mimeType).not.toBe("application/json");
    expect(download.preview).toMatchObject({
      label: SIMULATION_EXPORT_LABEL,
      filename: download.filename,
      completedWorkoutCount: 0,
      feedbackCount: 0,
    });
    expect(parsed).toMatchObject({
      artifactKind: "workout_simulation",
      label: SIMULATION_EXPORT_LABEL,
      schemaVersion: SIMULATION_EXPORT_SCHEMA_VERSION,
    });
    expect(download.content).toContain(SIMULATION_EXPORT_LABEL);
  });

  it("downloads the same labelled content using the distinct simulation presentation", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    const downloadedBlobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlobs.push(blob);
      return "blob:simulation-export";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    downloadSimulationExport(workspace());

    expect(anchor.download.startsWith(SIMULATION_EXPORT_FILENAME_PREFIX)).toBe(true);
    expect(anchor.href).toBe("blob:simulation-export");
    expect(anchor.click).toHaveBeenCalledOnce();
    const downloadedBlob = downloadedBlobs[0];
    expect(downloadedBlob).toBeInstanceOf(Blob);
    if (!downloadedBlob) throw new Error("The simulation export Blob was not created.");
    expect(downloadedBlob.type).toBe(SIMULATION_EXPORT_MIME_TYPE);
    expect(await downloadedBlob.text()).toContain(SIMULATION_EXPORT_LABEL);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:simulation-export");
  });
});
