import { FONT_SIZE_OPTIONS } from "@/lib/font-size";

export const WORKOUT_EXPERIENCE_VIEWPORTS = [320, 375, 390, 440, 1440] as const;

export const WORKOUT_EXPERIENCE_TEXT_SIZES = FONT_SIZE_OPTIONS.map(
  ({ key, detail }) => ({ key, percent: Number.parseInt(detail, 10) }),
);

export const MINIMUM_TOUCH_TARGET_PX = 44;

export const WORKOUT_EXPERIENCE_STATES = [
  "idle",
  "pending",
  "saving",
  "saved",
  "retrying",
  "needs_attention",
  "recovered",
] as const;

export type WorkoutExperienceState =
  (typeof WORKOUT_EXPERIENCE_STATES)[number];

export const WORKOUT_EXPERIENCE_SURFACES = [
  {
    id: "today",
    route: "/today",
    uiOwners: ["TodayPage", "WorkoutStartForm"],
    dataOwners: ["today", "dashboard", "review-decisions", "session-lifecycle"],
    invariant:
      "The current training decision leads; alternate selection, active resume, Program lineage, and truthful start recovery remain available.",
    phase: 3,
  },
  {
    id: "active-workout",
    route: "/session/[id]",
    uiOwners: ["SessionRunner", "ExerciseCard", "WorkoutStatusBar"],
    dataOwners: [
      "session-lifecycle",
      "session-occurrences",
      "workout-set-outbox",
      "occurrence-mutation-outbox",
      "equipment-selection-outbox",
    ],
    invariant:
      "Planned and performed truth stays distinct; progress and rest advance only after the exact durable acknowledgement, and finish fails closed while recorded work is unsaved.",
    phase: 4,
  },
  {
    id: "history",
    route: "/history",
    uiOwners: ["HistoryPage", "HistoryReport", "WorkoutDetailPage"],
    dataOwners: ["history-report", "history-lenses", "activity-report"],
    invariant:
      "All five evidence lenses, calendar navigation, completed detail, and independent activities remain available without treating warm-ups or activities as performed strength work.",
    phase: 5,
  },
  {
    id: "review",
    route: "/coach",
    uiOwners: ["ReviewPage", "RecommendationCard"],
    dataOwners: ["review-decisions", "recommendation-decisions", "coaching"],
    invariant:
      "Evidence and limitations lead; generated coaching stays secondary and no recommendation mutates the Program without explicit review and confirmation.",
    phase: 5,
  },
  {
    id: "program",
    route: "/program",
    uiOwners: ["ProgramViewer", "ProgramEditor", "ProgramImport", "CompilerReview"],
    dataOwners: [
      "program-documents",
      "program-drafts",
      "program-publication",
      "routine-import",
      "session-compiler",
    ],
    invariant:
      "Published versions remain immutable, omissions are not deletions, and imported or generated changes require review before publication or workout creation.",
    phase: 6,
  },
  {
    id: "settings",
    route: "/settings",
    uiOwners: ["SettingsPage", "EquipmentManager", "SetupReviewShell"],
    dataOwners: ["equipment-inventory", "setup-persistence", "ai-privacy"],
    invariant:
      "Preferences and safeguards remain explicit; equipment changes use stable owned identities and never silently rewrite the Program or workout history.",
    phase: 6,
  },
  {
    id: "recovery",
    route: "/recovery",
    uiOwners: ["RecoveryPage", "ArchivePage", "ExportPage"],
    dataOwners: [
      "snapshots",
      "recovery-manifest",
      "recovery-health",
      "archive",
      "permanent-delete",
      "export",
    ],
    invariant:
      "Normal removal is recoverable, restore verifies a safety copy and canonical manifest, and permanent deletion remains isolated behind Archive and fresh confirmation.",
    phase: 6,
  },
  {
    id: "simulation",
    route: "/simulation",
    uiOwners: ["SimulationShell", "SimulationRunner"],
    dataOwners: ["workout-simulation-source", "workout-simulation-storage"],
    invariant:
      "Simulation stays unmistakably labelled, device-only, non-durable, and unable to write canonical workout, Coach, History, export, Archive, or recovery records.",
    phase: 6,
  },
] as const;

export const FIXED_REDESIGN_WEIGHTS = {
  phase0: 24,
  phase1: 8,
  phase2: 18,
  phase3: 10,
  phase4: 18,
  phase5: 9,
  phase6: 7,
  release: 6,
} as const;
