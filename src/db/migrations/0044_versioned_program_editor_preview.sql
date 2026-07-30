CREATE VIEW program_editor_repair_preview AS
WITH active_program_counts AS (
  SELECT user_id, count(*)::integer AS active_count
  FROM programs
  WHERE status = 'active' AND archived_at IS NULL
  GROUP BY user_id
), version_ranks AS (
  SELECT pv.*,
         row_number() OVER (
           PARTITION BY pv.program_id
           ORDER BY pv.version_no DESC, pv.created_at DESC, pv.id DESC
         ) AS newest_rank,
         count(*) OVER (PARTITION BY pv.program_id, pv.version_no) AS number_count
  FROM program_versions pv
), slot_versions AS (
  SELECT wte.id, wte.workout_template_id, wte.lineage_id,
         wt.program_version_id, wt.lineage_id AS day_lineage_id
  FROM workout_template_exercises wte
  JOIN workout_templates wt ON wt.id = wte.workout_template_id
), pending_recommendations AS (
  SELECT r.*, sv.program_version_id AS source_program_version_id,
         sv.lineage_id AS actual_slot_lineage_id,
         pv.program_id
  FROM recommendations r
  LEFT JOIN slot_versions sv ON sv.id = r.source_template_exercise_id
  LEFT JOIN program_versions pv ON pv.id = sv.program_version_id
  WHERE r.status = 'pending' AND r.archived_at IS NULL
)
SELECT 'program'::text AS entity_type,
       p.id::text AS entity_id,
       'invalid_state'::text AS issue,
       jsonb_build_object('status', p.status, 'archivedAt', p.archived_at) AS evidence
FROM programs p
WHERE p.status NOT IN ('active', 'archived')
   OR (p.status = 'active' AND p.archived_at IS NOT NULL)
   OR (p.status = 'archived' AND p.archived_at IS NULL)
UNION ALL
SELECT 'user', c.user_id::text, 'active_program_count',
       jsonb_build_object('count', c.active_count)
FROM active_program_counts c
WHERE c.active_count <> 1
UNION ALL
SELECT 'program', p.id::text, 'missing_current_version',
       jsonb_build_object('status', p.status)
FROM programs p
WHERE p.status = 'active' AND p.archived_at IS NULL AND p.current_version_id IS NULL
UNION ALL
SELECT 'program', p.id::text, 'current_version_wrong_program',
       jsonb_build_object('currentVersionId', p.current_version_id, 'versionProgramId', pv.program_id)
FROM programs p
LEFT JOIN program_versions pv ON pv.id = p.current_version_id
WHERE p.current_version_id IS NOT NULL
  AND (pv.id IS NULL OR pv.program_id IS DISTINCT FROM p.id)
UNION ALL
SELECT 'program', p.id::text, 'current_version_not_newest',
       jsonb_build_object('currentVersionId', p.current_version_id, 'newestVersionId', newest.id)
FROM programs p
JOIN version_ranks newest ON newest.program_id = p.id AND newest.newest_rank = 1
WHERE p.status = 'active' AND p.archived_at IS NULL
  AND p.current_version_id IS DISTINCT FROM newest.id
UNION ALL
SELECT 'program', p.id::text, 'program_without_version', '{}'::jsonb
FROM programs p
WHERE NOT EXISTS (SELECT 1 FROM program_versions pv WHERE pv.program_id = p.id)
UNION ALL
SELECT 'program_version', vr.id::text, 'duplicate_or_invalid_version_number',
       jsonb_build_object('programId', vr.program_id, 'versionNo', vr.version_no, 'count', vr.number_count)
FROM version_ranks vr
WHERE vr.version_no < 1 OR vr.number_count > 1
UNION ALL
SELECT 'program_version', pv.id::text, 'cross_program_ancestry',
       jsonb_build_object('parentVersionId', pv.parent_version_id, 'restoredFromVersionId', pv.restored_from_version_id)
FROM program_versions pv
LEFT JOIN program_versions parent ON parent.id = pv.parent_version_id
LEFT JOIN program_versions restored ON restored.id = pv.restored_from_version_id
WHERE (pv.parent_version_id IS NOT NULL AND (parent.id IS NULL OR parent.program_id <> pv.program_id OR parent.version_no >= pv.version_no))
   OR (pv.restored_from_version_id IS NOT NULL AND (restored.id IS NULL OR restored.program_id <> pv.program_id))
UNION ALL
SELECT 'program_version', pv.id::text, 'incomplete_version_metadata',
       jsonb_build_object('name', pv.name, 'source', pv.publication_source, 'activatedAt', pv.activated_at)
FROM program_versions pv
WHERE nullif(btrim(pv.name), '') IS NULL
   OR pv.publication_source NOT IN ('setup', 'import', 'editor', 'recommendation', 'restore')
   OR pv.activated_at IS NULL
UNION ALL
SELECT 'workout_template', wt.id::text, 'invalid_or_duplicate_day_order',
       jsonb_build_object('versionId', wt.program_version_id, 'order', wt.order_idx)
FROM workout_templates wt
WHERE wt.order_idx < 0
   OR EXISTS (
     SELECT 1 FROM workout_templates peer
     WHERE peer.program_version_id = wt.program_version_id
       AND peer.order_idx = wt.order_idx AND peer.id <> wt.id
   )
UNION ALL
SELECT 'workout_template', wt.id::text, 'missing_or_duplicate_day_lineage',
       jsonb_build_object('versionId', wt.program_version_id, 'lineageId', wt.lineage_id)
FROM workout_templates wt
WHERE wt.lineage_id IS NULL
   OR EXISTS (
     SELECT 1 FROM workout_templates peer
     WHERE peer.program_version_id = wt.program_version_id
       AND peer.lineage_id = wt.lineage_id AND peer.id <> wt.id
   )
UNION ALL
SELECT 'superset_group', sg.id::text, 'invalid_superset',
       jsonb_build_object('templateId', sg.workout_template_id, 'order', sg.order_idx,
                          'lineageId', sg.lineage_id, 'name', sg.name,
                          'restAfterRoundSec', sg.rest_after_round_sec,
                          'memberCount', (SELECT count(*) FROM workout_template_exercises wte WHERE wte.superset_group_id = sg.id))
FROM superset_groups sg
WHERE sg.lineage_id IS NULL OR nullif(btrim(sg.name), '') IS NULL
   OR sg.order_idx < 0 OR sg.rest_after_round_sec NOT BETWEEN 0 AND 1800
   OR (SELECT count(*) FROM workout_template_exercises wte WHERE wte.superset_group_id = sg.id) < 2
   OR EXISTS (
     SELECT 1 FROM superset_groups peer
     WHERE peer.workout_template_id = sg.workout_template_id
       AND (peer.order_idx = sg.order_idx OR peer.lineage_id = sg.lineage_id)
       AND peer.id <> sg.id
   )
UNION ALL
SELECT 'template_exercise', wte.id::text, 'invalid_slot',
       jsonb_build_object('templateId', wte.workout_template_id, 'order', wte.order_idx,
                          'lineageId', wte.lineage_id, 'restSec', wte.rest_sec,
                          'supersetGroupId', wte.superset_group_id)
FROM workout_template_exercises wte
WHERE wte.lineage_id IS NULL OR wte.order_idx < 0 OR wte.rest_sec NOT BETWEEN 0 AND 1800
   OR EXISTS (
     SELECT 1 FROM workout_template_exercises peer
     WHERE peer.workout_template_id = wte.workout_template_id
       AND (peer.order_idx = wte.order_idx OR peer.lineage_id = wte.lineage_id)
       AND peer.id <> wte.id
   )
   OR EXISTS (
     SELECT 1 FROM superset_groups sg
     WHERE sg.id = wte.superset_group_id
       AND sg.workout_template_id <> wte.workout_template_id
   )
UNION ALL
SELECT 'template_exercise', sv.id::text, 'duplicate_slot_lineage_in_version',
       jsonb_build_object('versionId', sv.program_version_id, 'lineageId', sv.lineage_id)
FROM slot_versions sv
WHERE EXISTS (
  SELECT 1 FROM slot_versions peer
  WHERE peer.program_version_id = sv.program_version_id
    AND peer.lineage_id = sv.lineage_id AND peer.id <> sv.id
)
UNION ALL
SELECT 'exercise_prescription', ep.id::text, 'invalid_prescription',
       jsonb_build_object('sets', ep.sets, 'repMin', ep.rep_range_min, 'repMax', ep.rep_range_max,
                          'targetLoad', ep.target_load, 'targetLoadUnit', ep.target_load_unit)
FROM exercise_prescriptions ep
WHERE ep.sets NOT BETWEEN 1 AND 20
   OR ep.rep_range_min NOT BETWEEN 1 AND 100
   OR ep.rep_range_max NOT BETWEEN 1 AND 100
   OR ep.rep_range_min > ep.rep_range_max
   OR (ep.target_load IS NULL) <> (ep.target_load_unit IS NULL)
UNION ALL
SELECT 'template_exercise', wte.id::text, 'active_prescription_count',
       jsonb_build_object('count', (SELECT count(*) FROM exercise_prescriptions ep WHERE ep.template_exercise_id = wte.id AND ep.superseded_by_id IS NULL))
FROM workout_template_exercises wte
WHERE (SELECT count(*) FROM exercise_prescriptions ep WHERE ep.template_exercise_id = wte.id AND ep.superseded_by_id IS NULL) <> 1
UNION ALL
SELECT 'recommendation', r.id::text, 'pending_recommendation_missing_source',
       jsonb_build_object('sourceTemplateExerciseId', r.source_template_exercise_id,
                          'sourceSlotLineageId', r.source_slot_lineage_id)
FROM pending_recommendations r
WHERE (
  r.payload->>'kind' = 'deload'
  AND (
    r.source_template_exercise_id IS NOT NULL
    OR r.source_slot_lineage_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM programs p
      WHERE p.user_id = r.user_id
        AND p.status = 'active' AND p.archived_at IS NULL
        AND p.current_version_id IS NOT NULL
    )
  )
) OR (
  r.payload->>'kind' <> 'deload'
  AND (
    r.source_template_exercise_id IS NULL OR r.source_slot_lineage_id IS NULL
    OR r.actual_slot_lineage_id IS DISTINCT FROM r.source_slot_lineage_id
    OR NOT EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = r.program_id AND p.user_id = r.user_id
        AND p.status = 'active' AND p.archived_at IS NULL
        AND p.current_version_id = r.source_program_version_id
    )
  )
)
UNION ALL
SELECT 'recommendation', r.id::text, 'invalid_expired_reconciliation',
       jsonb_build_object('status', r.status, 'reason', r.reconciliation_reason, 'reconciledAt', r.reconciled_at)
FROM recommendations r
WHERE r.status = 'expired'
  AND (nullif(btrim(r.reconciliation_reason), '') IS NULL OR r.reconciled_at IS NULL)
UNION ALL
SELECT 'program_draft', draft.id::text, 'invalid_draft_relationship',
       jsonb_build_object('userId', draft.user_id, 'programId', draft.program_id,
                          'baseVersionId', draft.base_version_id,
                          'restoredFromVersionId', draft.restored_from_version_id,
                          'publishedVersionId', draft.published_version_id)
FROM program_drafts draft
LEFT JOIN programs program ON program.id = draft.program_id
LEFT JOIN program_versions base ON base.id = draft.base_version_id
LEFT JOIN program_versions restored ON restored.id = draft.restored_from_version_id
LEFT JOIN program_versions published ON published.id = draft.published_version_id
WHERE program.id IS NULL OR program.user_id <> draft.user_id
   OR base.id IS NULL OR base.program_id <> draft.program_id
   OR (draft.restored_from_version_id IS NOT NULL AND (restored.id IS NULL OR restored.program_id <> draft.program_id))
   OR (draft.published_version_id IS NOT NULL AND (published.id IS NULL OR published.program_id <> draft.program_id));
