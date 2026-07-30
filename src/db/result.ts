export type DatabaseRow = Record<string, unknown>;

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase()
  );
}

/** Top-level snake_case keys → camelCase; never touches nested values. */
export function camelRow<T extends DatabaseRow = DatabaseRow>(
  row: DatabaseRow
): T {
  const normalized: DatabaseRow = {};
  const entries = Object.entries(row).sort(([left], [right]) =>
    Number(left.includes("_")) - Number(right.includes("_"))
  );
  for (const [key, value] of entries) {
    Object.defineProperty(normalized, camelKey(key), {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return normalized as T;
}

/** Normalizes the raw result shapes returned by every supported Drizzle driver. */
export function resultRows<T extends DatabaseRow = DatabaseRow>(
  result: unknown
): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

export function camelRows<T extends DatabaseRow = DatabaseRow>(
  result: unknown
): T[] {
  return resultRows(result).map((row) => camelRow<T>(row));
}

export function databaseConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") break;
    if ("constraint" in current && typeof current.constraint === "string") {
      return current.constraint;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
