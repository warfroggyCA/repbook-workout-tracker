import "server-only";

import { sql, type SQL } from "drizzle-orm";

type ProgramWarmupSqlInput = {
  lineageId: SQL;
  fallbackItemKey: SQL;
  warmupNotes: SQL;
  warmupItems: SQL;
};

function fullNoteWarmupItemSql(input: ProgramWarmupSqlInput) {
  return sql`
    jsonb_build_array(jsonb_build_object(
      'key', ${input.fallbackItemKey}::text,
      'label', ${input.warmupNotes},
      'reps', NULL,
      'load', NULL,
      'loadUnit', NULL,
      'loadPercent', NULL,
      'loadText', NULL,
      'notes', NULL
    ))
  `;
}

/**
 * Preserves complete legacy free-text warm-ups without overriding deliberately
 * authored structured steps. Older schema upgrades generated one plain item
 * whose label was only the first 120 characters of the overview.
 */
export function effectiveProgramDayWarmupItemsSql(
  input: ProgramWarmupSqlInput,
) {
  return sql`
    CASE
      WHEN nullif(btrim(${input.warmupNotes}), '') IS NOT NULL
        AND jsonb_array_length(${input.warmupItems}) = 1
        AND ${input.warmupItems}->0->>'key' = ${input.lineageId}::text
        AND ${input.warmupItems}->0->>'label' =
          left(${input.warmupNotes}, 120)
        AND ${input.warmupItems}->0->>'reps' IS NULL
        AND ${input.warmupItems}->0->>'load' IS NULL
        AND ${input.warmupItems}->0->>'loadUnit' IS NULL
        AND ${input.warmupItems}->0->>'loadPercent' IS NULL
        AND ${input.warmupItems}->0->>'loadText' IS NULL
        AND ${input.warmupItems}->0->>'notes' IS NULL
      THEN ${fullNoteWarmupItemSql(input)}
      WHEN jsonb_array_length(${input.warmupItems}) > 0
        THEN ${input.warmupItems}
      WHEN nullif(btrim(${input.warmupNotes}), '') IS NOT NULL
        THEN ${fullNoteWarmupItemSql(input)}
      ELSE '[]'::jsonb
    END
  `;
}
