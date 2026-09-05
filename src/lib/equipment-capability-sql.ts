import { sql, type SQL } from "drizzle-orm";

/** SQL counterpart of equipmentItemProvidesType, inside atomic write guards. */
export function equipmentItemProvidesTypeSql(type: SQL, attrs: SQL, required: SQL): SQL {
  return sql`coalesce(${type}::text = ${required}::text OR (
    ${required}::text = 'cable'
    AND ${type}::text IN ('machine', 'smith_machine')
    AND ${attrs}->'cablePulley' = 'true'::jsonb
  ), false)`;
}
