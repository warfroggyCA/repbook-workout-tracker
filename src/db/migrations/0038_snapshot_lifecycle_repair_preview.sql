-- A row outside the two application-owned creation paths cannot be classified
-- safely. Operators must decide whether it is a named user recovery point or
-- an automatic safety copy before the retention contract can be enabled.
CREATE VIEW snapshot_lifecycle_repair_preview AS
SELECT
  'snapshot.unclassified_origin'::text AS issue,
  'data_snapshot'::text AS entity_type,
  snapshot.id::text AS entity_id,
  snapshot.user_id,
  jsonb_build_object(
    'name', snapshot.name,
    'reason', snapshot.reason,
    'pinned', snapshot.pinned,
    'status', snapshot.status,
    'createdAt', snapshot.created_at,
    'instruction', 'Set snapshot_kind to user for a named user-created recovery point, or automatic only when the application-generated safety origin is proven.'
  ) AS evidence
FROM data_snapshots snapshot
WHERE snapshot.snapshot_kind IS NULL;
