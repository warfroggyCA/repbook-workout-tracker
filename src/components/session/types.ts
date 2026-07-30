import type { PlateMathConfig, IncrementalLoadConfig } from "@/engine/plate-math";
import type { RoutineWarmupSet } from "@/db/schema/user";
import type { LiveCoachMessage } from "@/services/live-coaching";
import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";
import type { LoadUnit } from "@/lib/units";
import type { WorkoutSetLoadEntryMeaning } from "@/lib/workout-set-outbox";
import type { MachineLoadConfig } from "@/engine/machine-load-math";
import type { PerformedMetricType } from "@/lib/set-metric-semantics";

export type LoggedSet = {
  id: string;
  clientKey: string | null;
  setNo: number;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number;
  metricType?: PerformedMetricType;
  rpe: number | null;
  note: string | null;
  saveState?: "pending" | "saving" | "retrying" | "failed" | "saved";
  lastError?: string | null;
};

export type SessionExerciseData = {
  id: string;
  exerciseId: string;
  name: string;
  family: string | null;
  loadType: string;
  loadSemantics: string;
  metricType?: PerformedMetricType;
  movementPattern: string;
  orderIdx: number;
  supersetKey: string | null;
  restSec: number;
  modificationType: "as_planned" | "substituted" | "added" | "skipped";
  skipReason: string | null;
  substitutedForExerciseId: string | null;
  substitutionReason: "variety" | "equipment_busy" | "discomfort" | "other" | null;
  substitutedAt: string | null;
  plannedExerciseName: string | null;
  targetSets: number | null;
  targetRepsMin: number | null;
  targetRepsMax: number | null;
  targetLoad: number | null;
  targetLoadUnit: LoadUnit | null;
  notes: string | null;
  warmupNotes: string | null;
  warmupSets: RoutineWarmupSet[];
  setNotes: Array<string | null>;
  cautionBodyParts: string[];
  media: ExerciseMediaPreview | null;
  sets: LoggedSet[];
  last: {
    dateISO: string;
    sets: Array<{
      weight: number | null;
      weightUnit: LoadUnit | null;
      reps: number;
      rpe: number | null;
    }>;
  } | null;
};

export type SessionEquipmentOption = {
  key: string;
  equipmentItemId: string;
  equipmentLabel: string;
  attachmentItemId: string | null;
  attachmentLabel: string | null;
  guidance: string | null;
  loadEntryMeaning?: Exclude<WorkoutSetLoadEntryMeaning, "legacy_unknown"> | null;
  loadEntryMeaningChoices?: Array<"per_stack" | "combined_stacks">;
};

export type SessionEquipmentSetup = {
  /** Exercise and target identity used to calculate every setup guidance string. */
  sourceExerciseId: string;
  sourceTargetLoad: number | null;
  sourceTargetLoadUnit: LoadUnit | null;
  exact: boolean;
  status: "available" | "unavailable";
  selectionRequired: boolean;
  currentSnapshotId: string | null;
  currentEquipmentLabel: string | null;
  currentAttachmentLabel: string | null;
  currentGuidance: string | null;
  currentGuidanceByLoadEntryMeaning: Partial<
    Record<"per_stack" | "combined_stacks", string>
  >;
  currentSelectionAvailable: boolean;
  loadEntryMeaning: Exclude<WorkoutSetLoadEntryMeaning, "legacy_unknown"> | null;
  loadEntryMeaningChoices: Array<"per_stack" | "combined_stacks">;
  /** Immutable current-session machine geometry used by live set guidance. */
  machineLoadConfig?: MachineLoadConfig | null;
  options: SessionEquipmentOption[];
};

export type SessionOccurrenceData = {
  id: string;
  sessionExerciseId: string | null;
  kind: "day_warmup" | "exercise_warmup" | "working_set";
  origin: "planned" | "ad_hoc" | "imported" | "legacy";
  sequenceIdx: number;
  kindOrdinal: number;
  label: string | null;
  plannedExerciseId: string | null;
  plannedNote: string | null;
  plannedRepsMin: number | null;
  plannedRepsMax: number | null;
  plannedLoad: number | null;
  plannedLoadUnit: LoadUnit | null;
  plannedLoadPercent: number | null;
  plannedLoadText: string | null;
  plannedRestSec: number | null;
  groupSnapshotId: string | null;
  groupRound: number | null;
  groupMemberOrderIdx: number | null;
  outcome: "pending" | "completed" | "skipped" | "abandoned" | "legacy_unrecorded";
  outcomeReason: string | null;
  outcomeNote: string | null;
  revision: number;
  resolvedAt: string | null;
  completedSetId: string | null;
  restAfterSec: number;
};

export type SessionExerciseGroupData = {
  id: string;
  name: string;
  plannedRounds: number | null;
  memberCount: number | null;
  orderIdx: number;
};

export type SessionRunnerProps = {
  ownerId: string;
  sessionId: string;
  templateName: string;
  dayWarmupNotes: string | null;
  occurrences: SessionOccurrenceData[];
  exerciseGroups: SessionExerciseGroupData[];
  startedAtISO: string;
  exercises: SessionExerciseData[];
  /** keyed by session exercise id; never by broad load type. */
  plateConfigs: Record<string, PlateMathConfig>;
  equipmentSetups: Record<string, SessionEquipmentSetup>;
  /** keyed by loadType: "dumbbell" | "kettlebell" */
  incrementals: Record<string, IncrementalLoadConfig>;
  unit: LoadUnit;
  coachMessages: LiveCoachMessage[];
};
