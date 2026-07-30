import { createHash } from "node:crypto";
import type { Db } from "@/db";
import {
  captureUserSnapshot,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";

type SnapshotRow = Record<string, unknown>;

export type AcceptanceRoutineDurableState = {
  programTree: {
    programs: number;
    versions: number;
    currentVersionNumbers: number[];
    days: number;
    groups: number;
    slots: number;
    prescriptions: number;
    digest: string;
  };
  drafts: {
    count: number;
    states: Array<{ status: string; revision: number }>;
    digest: string;
  };
  proposals: { count: number; digest: string };
  recommendations: { count: number; digest: string };
  workouts: {
    sessions: number;
    occurrences: number;
    sets: number;
    digest: string;
  };
};

function rows(payload: CanonicalSnapshotPayload, table: string): SnapshotRow[] {
  return (payload.tables[table] ?? []) as SnapshotRow[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function summarizeAcceptanceRoutineSnapshot(
  payload: CanonicalSnapshotPayload,
): AcceptanceRoutineDurableState {
  const programs = rows(payload, "programs");
  const versions = rows(payload, "program_versions");
  const days = rows(payload, "workout_templates");
  const groups = rows(payload, "superset_groups");
  const slots = rows(payload, "workout_template_exercises");
  const prescriptions = rows(payload, "exercise_prescriptions");
  const drafts = rows(payload, "program_drafts");
  const proposals = rows(payload, "session_compiler_proposals");
  const recommendations = rows(payload, "recommendations");
  const sessions = rows(payload, "workout_sessions");
  const occurrences = rows(payload, "session_exercises");
  const sets = rows(payload, "completed_sets");
  const currentVersionIds = new Set(
    programs
      .filter((program) => program.status === "active" && program.archived_at == null)
      .map((program) => program.current_version_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const currentVersionNumbers = versions
    .filter((version) => currentVersionIds.has(String(version.id)))
    .map((version) => Number(version.version_no))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const programTree = [programs, versions, days, groups, slots, prescriptions];

  return {
    programTree: {
      programs: programs.length,
      versions: versions.length,
      currentVersionNumbers,
      days: days.length,
      groups: groups.length,
      slots: slots.length,
      prescriptions: prescriptions.length,
      digest: digest(programTree),
    },
    drafts: {
      count: drafts.length,
      states: drafts
        .map((draft) => ({
          status: String(draft.status),
          revision: Number(draft.revision),
        }))
        .sort((left, right) =>
          left.status.localeCompare(right.status) || left.revision - right.revision,
        ),
      digest: digest(drafts),
    },
    proposals: { count: proposals.length, digest: digest(proposals) },
    recommendations: {
      count: recommendations.length,
      digest: digest(recommendations),
    },
    workouts: {
      sessions: sessions.length,
      occurrences: occurrences.length,
      sets: sets.length,
      digest: digest([sessions, occurrences, sets]),
    },
  };
}

export async function captureAcceptanceRoutineState(
  db: Db,
  userId: string,
): Promise<AcceptanceRoutineDurableState> {
  const snapshot = await captureUserSnapshot(
    db,
    userId,
    new Date(0),
    "acceptance-routine-state",
  );
  return summarizeAcceptanceRoutineSnapshot(snapshot);
}
