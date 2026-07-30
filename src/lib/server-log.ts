import "server-only";

type Level = "info" | "warn" | "error";

const MAX_STRING_LENGTH = 500;

function truncate(value: string): string {
  return value.slice(0, MAX_STRING_LENGTH);
}

/** Emits one privacy-reviewed JSON event without ever affecting application flow. */
export function logServerEvent(
  level: Level,
  event: string,
  fields: Record<string, string | number | boolean | null> = {}
): void {
  try {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? truncate(value) : value,
      ])
    );
    console.log(
      JSON.stringify({
        ...safeFields,
        level,
        event: truncate(event),
        at: new Date().toISOString(),
      })
    );
  } catch {
    // Logging must never change the application behavior it observes.
  }
}
