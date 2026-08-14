import { relations } from "drizzle-orm";
import { users, userProfiles, constraints } from "./user";
import {
  equipmentDefinitions,
  equipmentItems,
  plateInventory,
  barbellConfigs,
  plateLoadedMachineProfiles,
  plateLoadedMachineCompatiblePlates,
  cableMachineProfiles,
  cableStackSteps,
  cableAttachmentProfiles,
  cableAttachmentCompatibilities,
} from "./equipment";
import {
  exerciseFamilies,
  exercises,
  exerciseAliases,
  exerciseSources,
  exerciseMediaAssets,
  exerciseMediaAssociations,
  externalExerciseMappings,
  exerciseEquipmentRequirements,
} from "./exercise";
import {
  programs,
  programVersions,
  workoutTemplates,
  supersetGroups,
  workoutTemplateExercises,
  exercisePrescriptions,
  programDrafts,
} from "./program";
import {
  programSchedules,
  programScheduleVersions,
  scheduledProgramEvents,
} from "./schedule";
import {
  workoutSessions,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  sessionEquipmentSnapshots,
  sessionEquipmentSelectionReceipts,
  sessionOccurrenceMutations,
  completedSets,
  painLogs,
  fatigueLogs,
  sessionNotes,
} from "./session";
import { healthActivities } from "./activity";
import {
  archiveOperationRecords,
  archiveOperations,
  permanentDeleteGrants,
} from "./archive";
import { dataSnapshots } from "./snapshot";
import { recordVersions } from "./version";
import { integrityFindings, recoveryRuns } from "./recovery";
import {
  adaptationEvents,
  coachingInsights,
  recommendations,
  userDecisions,
} from "./coaching";
import { historyImportBatches, importEvents } from "./events";
import { contextualNoteRevisions, contextualNotes } from "./contextual-note";

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, {
    fields: [users.id],
    references: [userProfiles.userId],
  }),
  constraints: many(constraints),
  equipmentItems: many(equipmentItems),
  plateInventory: many(plateInventory),
  barbellConfigs: many(barbellConfigs),
  programs: many(programs),
  programSchedules: many(programSchedules),
  programScheduleVersions: many(programScheduleVersions),
  scheduledProgramEvents: many(scheduledProgramEvents),
  sessions: many(workoutSessions),
  sessionEquipmentSnapshots: many(sessionEquipmentSnapshots),
  sessionEquipmentSelectionReceipts: many(sessionEquipmentSelectionReceipts),
  coachingInsights: many(coachingInsights),
  healthActivities: many(healthActivities),
  archiveOperations: many(archiveOperations),
  permanentDeleteGrants: many(permanentDeleteGrants),
  dataSnapshots: many(dataSnapshots),
  recordVersions: many(recordVersions),
  recoveryRuns: many(recoveryRuns),
  integrityFindings: many(integrityFindings),
  contextualNotes: many(contextualNotes),
  contextualNoteRevisions: many(contextualNoteRevisions),
}));

export const contextualNotesRelations = relations(
  contextualNotes,
  ({ one, many }) => ({
    user: one(users, {
      fields: [contextualNotes.userId],
      references: [users.id],
    }),
    session: one(workoutSessions, {
      fields: [contextualNotes.sessionId],
      references: [workoutSessions.id],
    }),
    sessionExercise: one(sessionExercises, {
      fields: [contextualNotes.sessionExerciseId],
      references: [sessionExercises.id],
    }),
    occurrence: one(sessionOccurrences, {
      fields: [contextualNotes.occurrenceId],
      references: [sessionOccurrences.id],
    }),
    completedSet: one(completedSets, {
      fields: [contextualNotes.completedSetId],
      references: [completedSets.id],
    }),
    program: one(programs, {
      fields: [contextualNotes.programId],
      references: [programs.id],
    }),
    programVersion: one(programVersions, {
      fields: [contextualNotes.programVersionId],
      references: [programVersions.id],
    }),
    workoutTemplate: one(workoutTemplates, {
      fields: [contextualNotes.workoutTemplateId],
      references: [workoutTemplates.id],
    }),
    workoutTemplateExercise: one(workoutTemplateExercises, {
      fields: [contextualNotes.workoutTemplateExerciseId],
      references: [workoutTemplateExercises.id],
    }),
    archiveOperation: one(archiveOperations, {
      fields: [contextualNotes.archiveOperationId],
      references: [archiveOperations.id],
    }),
    revisions: many(contextualNoteRevisions),
  }),
);

export const contextualNoteRevisionsRelations = relations(
  contextualNoteRevisions,
  ({ one }) => ({
    note: one(contextualNotes, {
      fields: [contextualNoteRevisions.noteId],
      references: [contextualNotes.id],
    }),
    user: one(users, {
      fields: [contextualNoteRevisions.userId],
      references: [users.id],
    }),
  }),
);

export const recoveryRunsRelations = relations(
  recoveryRuns,
  ({ one, many }) => ({
    user: one(users, {
      fields: [recoveryRuns.userId],
      references: [users.id],
    }),
    findings: many(integrityFindings),
  })
);

export const integrityFindingsRelations = relations(
  integrityFindings,
  ({ one }) => ({
    run: one(recoveryRuns, {
      fields: [integrityFindings.runId],
      references: [recoveryRuns.id],
    }),
    user: one(users, {
      fields: [integrityFindings.userId],
      references: [users.id],
    }),
  })
);

export const recordVersionsRelations = relations(recordVersions, ({ one }) => ({
  user: one(users, {
    fields: [recordVersions.userId],
    references: [users.id],
  }),
}));

export const dataSnapshotsRelations = relations(dataSnapshots, ({ one }) => ({
  user: one(users, {
    fields: [dataSnapshots.userId],
    references: [users.id],
  }),
  sourceOperation: one(archiveOperations, {
    fields: [dataSnapshots.sourceOperationId],
    references: [archiveOperations.id],
  }),
}));

export const archiveOperationsRelations = relations(
  archiveOperations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [archiveOperations.userId],
      references: [users.id],
    }),
    records: many(archiveOperationRecords),
    permanentDeleteGrants: many(permanentDeleteGrants),
  })
);

export const permanentDeleteGrantsRelations = relations(
  permanentDeleteGrants,
  ({ one }) => ({
    user: one(users, {
      fields: [permanentDeleteGrants.userId],
      references: [users.id],
    }),
    operation: one(archiveOperations, {
      fields: [permanentDeleteGrants.operationId],
      references: [archiveOperations.id],
    }),
  })
);

export const archiveOperationRecordsRelations = relations(
  archiveOperationRecords,
  ({ one }) => ({
    operation: one(archiveOperations, {
      fields: [archiveOperationRecords.operationId],
      references: [archiveOperations.id],
    }),
    user: one(users, {
      fields: [archiveOperationRecords.userId],
      references: [users.id],
    }),
  })
);

export const healthActivitiesRelations = relations(
  healthActivities,
  ({ one }) => ({
    user: one(users, {
      fields: [healthActivities.userId],
      references: [users.id],
    }),
  })
);

export const exerciseFamiliesRelations = relations(exerciseFamilies, ({ many }) => ({
  exercises: many(exercises),
  mediaAssociations: many(exerciseMediaAssociations),
}));

export const exercisesRelations = relations(exercises, ({ one, many }) => ({
  family: one(exerciseFamilies, {
    fields: [exercises.familyId],
    references: [exerciseFamilies.id],
  }),
  aliases: many(exerciseAliases),
  sources: many(exerciseSources),
  mediaAssociations: many(exerciseMediaAssociations),
  externalMappings: many(externalExerciseMappings),
  equipmentRequirements: many(exerciseEquipmentRequirements),
}));

export const exerciseMediaAssetsRelations = relations(
  exerciseMediaAssets,
  ({ many }) => ({
    associations: many(exerciseMediaAssociations),
  })
);

export const exerciseMediaAssociationsRelations = relations(
  exerciseMediaAssociations,
  ({ one }) => ({
    asset: one(exerciseMediaAssets, {
      fields: [exerciseMediaAssociations.assetId],
      references: [exerciseMediaAssets.id],
    }),
    exercise: one(exercises, {
      fields: [exerciseMediaAssociations.exerciseId],
      references: [exercises.id],
    }),
    family: one(exerciseFamilies, {
      fields: [exerciseMediaAssociations.familyId],
      references: [exerciseFamilies.id],
    }),
  })
);

export const exerciseSourcesRelations = relations(exerciseSources, ({ one }) => ({
  exercise: one(exercises, {
    fields: [exerciseSources.exerciseId],
    references: [exercises.id],
  }),
}));

export const externalExerciseMappingsRelations = relations(
  externalExerciseMappings,
  ({ one }) => ({
    exercise: one(exercises, {
      fields: [externalExerciseMappings.exerciseId],
      references: [exercises.id],
    }),
    user: one(users, {
      fields: [externalExerciseMappings.userId],
      references: [users.id],
    }),
  })
);

export const equipmentDefinitionsRelations = relations(
  equipmentDefinitions,
  ({ many }) => ({
    inventoryItems: many(equipmentItems),
    exerciseRequirements: many(exerciseEquipmentRequirements),
  })
);

export const equipmentItemsRelations = relations(
  equipmentItems,
  ({ one }) => ({
    user: one(users, {
      fields: [equipmentItems.userId],
      references: [users.id],
    }),
    barbellConfig: one(barbellConfigs),
    machineProfile: one(plateLoadedMachineProfiles),
    cableProfile: one(cableMachineProfiles),
    attachmentProfile: one(cableAttachmentProfiles),
  }),
);

export const barbellConfigsRelations = relations(barbellConfigs, ({ one }) => ({
  user: one(users, {
    fields: [barbellConfigs.userId],
    references: [users.id],
  }),
  equipmentItem: one(equipmentItems, {
    fields: [barbellConfigs.equipmentItemId],
    references: [equipmentItems.id],
  }),
}));

export const plateLoadedMachineProfilesRelations = relations(
  plateLoadedMachineProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [plateLoadedMachineProfiles.userId],
      references: [users.id],
    }),
    equipmentItem: one(equipmentItems, {
      fields: [plateLoadedMachineProfiles.equipmentItemId],
      references: [equipmentItems.id],
    }),
    compatiblePlates: many(plateLoadedMachineCompatiblePlates),
  }),
);

export const plateLoadedMachineCompatiblePlatesRelations = relations(
  plateLoadedMachineCompatiblePlates,
  ({ one }) => ({
    machineProfile: one(plateLoadedMachineProfiles, {
      fields: [plateLoadedMachineCompatiblePlates.machineProfileId],
      references: [plateLoadedMachineProfiles.id],
    }),
    plate: one(plateInventory, {
      fields: [plateLoadedMachineCompatiblePlates.plateInventoryId],
      references: [plateInventory.id],
    }),
  }),
);

export const cableMachineProfilesRelations = relations(
  cableMachineProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [cableMachineProfiles.userId],
      references: [users.id],
    }),
    equipmentItem: one(equipmentItems, {
      fields: [cableMachineProfiles.equipmentItemId],
      references: [equipmentItems.id],
    }),
    stackSteps: many(cableStackSteps),
    attachments: many(cableAttachmentCompatibilities),
  }),
);

export const cableStackStepsRelations = relations(cableStackSteps, ({ one }) => ({
  cableProfile: one(cableMachineProfiles, {
    fields: [cableStackSteps.cableProfileId],
    references: [cableMachineProfiles.id],
  }),
}));

export const cableAttachmentProfilesRelations = relations(
  cableAttachmentProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [cableAttachmentProfiles.userId],
      references: [users.id],
    }),
    equipmentItem: one(equipmentItems, {
      fields: [cableAttachmentProfiles.equipmentItemId],
      references: [equipmentItems.id],
    }),
    cables: many(cableAttachmentCompatibilities),
  }),
);

export const cableAttachmentCompatibilitiesRelations = relations(
  cableAttachmentCompatibilities,
  ({ one }) => ({
    cableProfile: one(cableMachineProfiles, {
      fields: [cableAttachmentCompatibilities.cableProfileId],
      references: [cableMachineProfiles.id],
    }),
    attachmentProfile: one(cableAttachmentProfiles, {
      fields: [cableAttachmentCompatibilities.attachmentProfileId],
      references: [cableAttachmentProfiles.id],
    }),
  }),
);

export const exerciseAliasesRelations = relations(exerciseAliases, ({ one }) => ({
  exercise: one(exercises, {
    fields: [exerciseAliases.exerciseId],
    references: [exercises.id],
  }),
}));

export const exerciseEquipmentRequirementsRelations = relations(
  exerciseEquipmentRequirements,
  ({ one }) => ({
    exercise: one(exercises, {
      fields: [exerciseEquipmentRequirements.exerciseId],
      references: [exercises.id],
    }),
    definition: one(equipmentDefinitions, {
      fields: [exerciseEquipmentRequirements.equipmentDefinitionId],
      references: [equipmentDefinitions.id],
    }),
  })
);

export const historyImportBatchesRelations = relations(
  historyImportBatches,
  ({ one, many }) => ({
    user: one(users, {
      fields: [historyImportBatches.userId],
      references: [users.id],
    }),
    importEvent: one(importEvents, {
      fields: [historyImportBatches.importEventId],
      references: [importEvents.id],
    }),
    sessions: many(workoutSessions),
  })
);

export const programsRelations = relations(programs, ({ one, many }) => ({
  versions: many(programVersions),
  currentVersion: one(programVersions, {
    fields: [programs.currentVersionId],
    references: [programVersions.id],
    relationName: "programCurrentVersion",
  }),
  schedule: one(programSchedules),
  scheduledEvents: many(scheduledProgramEvents),
  drafts: many(programDrafts),
}));

export const programVersionsRelations = relations(
  programVersions,
  ({ one, many }) => ({
    program: one(programs, {
      fields: [programVersions.programId],
      references: [programs.id],
    }),
    currentForProgram: one(programs, {
      fields: [programVersions.id],
      references: [programs.currentVersionId],
      relationName: "programCurrentVersion",
    }),
    parentVersion: one(programVersions, {
      fields: [programVersions.parentVersionId],
      references: [programVersions.id],
      relationName: "programVersionParent",
    }),
    baseDrafts: many(programDrafts, {
      relationName: "programDraftBaseVersion",
    }),
    publishedDrafts: many(programDrafts, {
      relationName: "programDraftPublishedVersion",
    }),
    scheduleVersions: many(programScheduleVersions, {
      relationName: "programScheduleVersionSourceProgramVersion",
    }),
    scheduledEvents: many(scheduledProgramEvents, {
      relationName: "scheduledEventSourceProgramVersion",
    }),
    templates: many(workoutTemplates),
  })
);

export const programSchedulesRelations = relations(
  programSchedules,
  ({ one, many }) => ({
    user: one(users, {
      fields: [programSchedules.userId],
      references: [users.id],
    }),
    program: one(programs, {
      fields: [programSchedules.programId],
      references: [programs.id],
    }),
    currentVersion: one(programScheduleVersions, {
      fields: [programSchedules.currentVersionId],
      references: [programScheduleVersions.id],
      relationName: "programScheduleCurrentVersion",
    }),
    versions: many(programScheduleVersions, {
      relationName: "programScheduleVersionRoot",
    }),
    events: many(scheduledProgramEvents),
  }),
);

export const programScheduleVersionsRelations = relations(
  programScheduleVersions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [programScheduleVersions.userId],
      references: [users.id],
    }),
    program: one(programs, {
      fields: [programScheduleVersions.programId],
      references: [programs.id],
    }),
    schedule: one(programSchedules, {
      fields: [programScheduleVersions.scheduleId],
      references: [programSchedules.id],
      relationName: "programScheduleVersionRoot",
    }),
    currentForSchedule: one(programSchedules, {
      fields: [programScheduleVersions.id],
      references: [programSchedules.currentVersionId],
      relationName: "programScheduleCurrentVersion",
    }),
    parentVersion: one(programScheduleVersions, {
      fields: [programScheduleVersions.parentVersionId],
      references: [programScheduleVersions.id],
      relationName: "programScheduleVersionParent",
    }),
    childVersions: many(programScheduleVersions, {
      relationName: "programScheduleVersionParent",
    }),
    sourceProgramVersion: one(programVersions, {
      fields: [programScheduleVersions.sourceProgramVersionId],
      references: [programVersions.id],
      relationName: "programScheduleVersionSourceProgramVersion",
    }),
    events: many(scheduledProgramEvents),
  }),
);

export const scheduledProgramEventsRelations = relations(
  scheduledProgramEvents,
  ({ one }) => ({
    user: one(users, {
      fields: [scheduledProgramEvents.userId],
      references: [users.id],
    }),
    program: one(programs, {
      fields: [scheduledProgramEvents.programId],
      references: [programs.id],
    }),
    schedule: one(programSchedules, {
      fields: [scheduledProgramEvents.scheduleId],
      references: [programSchedules.id],
    }),
    scheduleVersion: one(programScheduleVersions, {
      fields: [scheduledProgramEvents.scheduleVersionId],
      references: [programScheduleVersions.id],
    }),
    sourceProgramVersion: one(programVersions, {
      fields: [scheduledProgramEvents.sourceProgramVersionId],
      references: [programVersions.id],
      relationName: "scheduledEventSourceProgramVersion",
    }),
    routineTemplate: one(workoutTemplates, {
      fields: [
        scheduledProgramEvents.sourceProgramVersionId,
        scheduledProgramEvents.routineLineageId,
      ],
      references: [
        workoutTemplates.programVersionId,
        workoutTemplates.lineageId,
      ],
      relationName: "scheduledEventRoutine",
    }),
  }),
);

export const programDraftsRelations = relations(programDrafts, ({ one }) => ({
  user: one(users, {
    fields: [programDrafts.userId],
    references: [users.id],
  }),
  program: one(programs, {
    fields: [programDrafts.programId],
    references: [programs.id],
  }),
  baseVersion: one(programVersions, {
    fields: [programDrafts.baseVersionId],
    references: [programVersions.id],
    relationName: "programDraftBaseVersion",
  }),
  publishedVersion: one(programVersions, {
    fields: [programDrafts.publishedVersionId],
    references: [programVersions.id],
    relationName: "programDraftPublishedVersion",
  }),
}));

export const workoutTemplatesRelations = relations(
  workoutTemplates,
  ({ one, many }) => ({
    programVersion: one(programVersions, {
      fields: [workoutTemplates.programVersionId],
      references: [programVersions.id],
    }),
    scheduledEvents: many(scheduledProgramEvents, {
      relationName: "scheduledEventRoutine",
    }),
    exercises: many(workoutTemplateExercises),
    sessionSnapshots: many(sessionExerciseGroups),
    supersetGroups: many(supersetGroups),
  })
);

export const supersetGroupsRelations = relations(
  supersetGroups,
  ({ one, many }) => ({
    template: one(workoutTemplates, {
      fields: [supersetGroups.workoutTemplateId],
      references: [workoutTemplates.id],
    }),
    exercises: many(workoutTemplateExercises),
  })
);

export const workoutTemplateExercisesRelations = relations(
  workoutTemplateExercises,
  ({ one, many }) => ({
    template: one(workoutTemplates, {
      fields: [workoutTemplateExercises.workoutTemplateId],
      references: [workoutTemplates.id],
    }),
    exercise: one(exercises, {
      fields: [workoutTemplateExercises.exerciseId],
      references: [exercises.id],
    }),
    supersetGroup: one(supersetGroups, {
      fields: [workoutTemplateExercises.supersetGroupId],
      references: [supersetGroups.id],
    }),
    prescriptions: many(exercisePrescriptions),
  })
);

export const exercisePrescriptionsRelations = relations(
  exercisePrescriptions,
  ({ one }) => ({
    templateExercise: one(workoutTemplateExercises, {
      fields: [exercisePrescriptions.templateExerciseId],
      references: [workoutTemplateExercises.id],
    }),
  })
);

export const workoutSessionsRelations = relations(
  workoutSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [workoutSessions.userId],
      references: [users.id],
    }),
    template: one(workoutTemplates, {
      fields: [workoutSessions.templateId],
      references: [workoutTemplates.id],
    }),
    importBatch: one(historyImportBatches, {
      fields: [workoutSessions.importBatchId],
      references: [historyImportBatches.id],
    }),
    exercises: many(sessionExercises),
    exerciseGroups: many(sessionExerciseGroups),
    occurrences: many(sessionOccurrences),
    equipmentSnapshots: many(sessionEquipmentSnapshots),
    equipmentSelectionReceipts: many(sessionEquipmentSelectionReceipts),
    painLogs: many(painLogs),
    notes: many(sessionNotes),
    coachingInsights: many(coachingInsights),
  })
);

export const sessionExerciseGroupsRelations = relations(
  sessionExerciseGroups,
  ({ one, many }) => ({
    session: one(workoutSessions, {
      fields: [sessionExerciseGroups.sessionId],
      references: [workoutSessions.id],
    }),
    sourceGroup: one(supersetGroups, {
      fields: [sessionExerciseGroups.sourceGroupId],
      references: [supersetGroups.id],
    }),
    exercises: many(sessionExercises),
    occurrences: many(sessionOccurrences),
  }),
);

export const sessionExercisesRelations = relations(
  sessionExercises,
  ({ one, many }) => ({
    session: one(workoutSessions, {
      fields: [sessionExercises.sessionId],
      references: [workoutSessions.id],
    }),
    exercise: one(exercises, {
      fields: [sessionExercises.exerciseId],
      references: [exercises.id],
    }),
    groupSnapshot: one(sessionExerciseGroups, {
      fields: [sessionExercises.groupSnapshotId],
      references: [sessionExerciseGroups.id],
    }),
    sets: many(completedSets),
    occurrences: many(sessionOccurrences),
    equipmentSnapshots: many(sessionEquipmentSnapshots),
    currentEquipmentSnapshot: one(sessionEquipmentSnapshots, {
      fields: [sessionExercises.currentEquipmentSnapshotId],
      references: [sessionEquipmentSnapshots.id],
      relationName: "sessionExerciseCurrentEquipmentSnapshot",
    }),
    equipmentSelectionReceipts: many(sessionEquipmentSelectionReceipts),
  })
);

export const sessionEquipmentSnapshotsRelations = relations(
  sessionEquipmentSnapshots,
  ({ one, many }) => ({
    user: one(users, {
      fields: [sessionEquipmentSnapshots.userId],
      references: [users.id],
    }),
    session: one(workoutSessions, {
      fields: [sessionEquipmentSnapshots.sessionId],
      references: [workoutSessions.id],
    }),
    sessionExercise: one(sessionExercises, {
      fields: [sessionEquipmentSnapshots.sessionExerciseId],
      references: [sessionExercises.id],
    }),
    selectedForExercises: many(sessionExercises, {
      relationName: "sessionExerciseCurrentEquipmentSnapshot",
    }),
    completedSets: many(completedSets),
    occurrences: many(sessionOccurrences),
    priorSelectionReceipts: many(sessionEquipmentSelectionReceipts, {
      relationName: "equipmentSelectionPriorSnapshot",
    }),
    resultingSelectionReceipts: many(sessionEquipmentSelectionReceipts, {
      relationName: "equipmentSelectionResultingSnapshot",
    }),
  }),
);

export const sessionEquipmentSelectionReceiptsRelations = relations(
  sessionEquipmentSelectionReceipts,
  ({ one }) => ({
    user: one(users, {
      fields: [sessionEquipmentSelectionReceipts.userId],
      references: [users.id],
    }),
    session: one(workoutSessions, {
      fields: [sessionEquipmentSelectionReceipts.sessionId],
      references: [workoutSessions.id],
    }),
    sessionExercise: one(sessionExercises, {
      fields: [sessionEquipmentSelectionReceipts.sessionExerciseId],
      references: [sessionExercises.id],
    }),
    priorSnapshot: one(sessionEquipmentSnapshots, {
      fields: [sessionEquipmentSelectionReceipts.priorSnapshotId],
      references: [sessionEquipmentSnapshots.id],
      relationName: "equipmentSelectionPriorSnapshot",
    }),
    resultingSnapshot: one(sessionEquipmentSnapshots, {
      fields: [sessionEquipmentSelectionReceipts.resultingSnapshotId],
      references: [sessionEquipmentSnapshots.id],
      relationName: "equipmentSelectionResultingSnapshot",
    }),
  }),
);

export const sessionOccurrencesRelations = relations(
  sessionOccurrences,
  ({ one, many }) => ({
    session: one(workoutSessions, {
      fields: [sessionOccurrences.sessionId],
      references: [workoutSessions.id],
    }),
    sessionExercise: one(sessionExercises, {
      fields: [sessionOccurrences.sessionExerciseId],
      references: [sessionExercises.id],
    }),
    plannedExercise: one(exercises, {
      fields: [sessionOccurrences.plannedExerciseId],
      references: [exercises.id],
    }),
    groupSnapshot: one(sessionExerciseGroups, {
      fields: [sessionOccurrences.groupSnapshotId],
      references: [sessionExerciseGroups.id],
    }),
    completedSet: one(completedSets, {
      fields: [sessionOccurrences.completedSetId],
      references: [completedSets.id],
    }),
    mutations: many(sessionOccurrenceMutations),
    equipmentSnapshot: one(sessionEquipmentSnapshots, {
      fields: [sessionOccurrences.equipmentSnapshotId],
      references: [sessionEquipmentSnapshots.id],
    }),
  }),
);

export const sessionOccurrenceMutationsRelations = relations(
  sessionOccurrenceMutations,
  ({ one }) => ({
    occurrence: one(sessionOccurrences, {
      fields: [sessionOccurrenceMutations.occurrenceId],
      references: [sessionOccurrences.id],
    }),
  }),
);

export const completedSetsRelations = relations(completedSets, ({ one }) => ({
  sessionExercise: one(sessionExercises, {
    fields: [completedSets.sessionExerciseId],
    references: [sessionExercises.id],
  }),
  occurrence: one(sessionOccurrences),
  equipmentSnapshot: one(sessionEquipmentSnapshots, {
    fields: [completedSets.equipmentSnapshotId],
    references: [sessionEquipmentSnapshots.id],
  }),
}));

export const painLogsRelations = relations(painLogs, ({ one }) => ({
  session: one(workoutSessions, {
    fields: [painLogs.sessionId],
    references: [workoutSessions.id],
  }),
  exercise: one(exercises, {
    fields: [painLogs.exerciseId],
    references: [exercises.id],
  }),
}));

export const sessionNotesRelations = relations(sessionNotes, ({ one }) => ({
  session: one(workoutSessions, {
    fields: [sessionNotes.sessionId],
    references: [workoutSessions.id],
  }),
}));

export const fatigueLogsRelations = relations(fatigueLogs, ({ one }) => ({
  session: one(workoutSessions, {
    fields: [fatigueLogs.sessionId],
    references: [workoutSessions.id],
  }),
}));

export const coachingInsightsRelations = relations(
  coachingInsights,
  ({ one }) => ({
    user: one(users, {
      fields: [coachingInsights.userId],
      references: [users.id],
    }),
    session: one(workoutSessions, {
      fields: [coachingInsights.sessionId],
      references: [workoutSessions.id],
    }),
    sessionExercise: one(sessionExercises, {
      fields: [coachingInsights.sessionExerciseId],
      references: [sessionExercises.id],
    }),
    completedSet: one(completedSets, {
      fields: [coachingInsights.completedSetId],
      references: [completedSets.id],
    }),
  })
);

export const recommendationsRelations = relations(
  recommendations,
  ({ one, many }) => ({
    exercise: one(exercises, {
      fields: [recommendations.exerciseId],
      references: [exercises.id],
    }),
    decisions: many(userDecisions),
    adaptations: many(adaptationEvents),
  })
);

export const userDecisionsRelations = relations(userDecisions, ({ one }) => ({
  recommendation: one(recommendations, {
    fields: [userDecisions.recommendationId],
    references: [recommendations.id],
  }),
}));

export const adaptationEventsRelations = relations(
  adaptationEvents,
  ({ one }) => ({
    recommendation: one(recommendations, {
      fields: [adaptationEvents.recommendationId],
      references: [recommendations.id],
    }),
  })
);
