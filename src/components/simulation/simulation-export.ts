import type { SimulationWorkspace } from "@/lib/workout-simulation";

export const SIMULATION_EXPORT_LABEL = "SIMULATION — NOT A WORKOUT RECORD";
export const SIMULATION_EXPORT_SCHEMA_VERSION = 1 as const;
export const SIMULATION_EXPORT_FILENAME_PREFIX = "workout-simulation-";
export const SIMULATION_EXPORT_MIME_TYPE =
  "application/vnd.workout-tracker.simulation+json;charset=utf-8";

export function buildSimulationExport(workspace: SimulationWorkspace) {
  return {
    artifactKind: "workout_simulation" as const,
    label: SIMULATION_EXPORT_LABEL,
    schemaVersion: SIMULATION_EXPORT_SCHEMA_VERSION,
    simulationId: workspace.simulationId,
    sourceProgram: {
      name: workspace.source.program.name,
      versionNo: workspace.source.program.versionNo,
      sourceDigest: workspace.source.sourceDigest,
    },
    createdAtISO: workspace.createdAtISO,
    updatedAtISO: workspace.updatedAtISO,
    completedWorkouts: workspace.completedWorkouts,
    feedback: workspace.feedback,
  };
}

export function buildSimulationExportDownload(workspace: SimulationWorkspace) {
  const artifact = buildSimulationExport(workspace);
  const filename = `${SIMULATION_EXPORT_FILENAME_PREFIX}${workspace.simulationId}.json`;

  return {
    artifact,
    content: JSON.stringify(artifact, null, 2),
    filename,
    mimeType: SIMULATION_EXPORT_MIME_TYPE,
    preview: {
      label: SIMULATION_EXPORT_LABEL,
      filename,
      completedWorkoutCount: artifact.completedWorkouts.length,
      feedbackCount: artifact.feedback.length,
    },
  };
}

export function downloadSimulationExport(workspace: SimulationWorkspace) {
  const download = buildSimulationExportDownload(workspace);
  const blob = new Blob([download.content], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = download.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
