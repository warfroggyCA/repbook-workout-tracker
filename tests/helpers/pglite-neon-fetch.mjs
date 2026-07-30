import { PGlite } from "@electric-sql/pglite";

const dataDir = process.env.PGLITE_DIR;
if (!dataDir) throw new Error("PGLITE_DIR is required by the optimized E2E database bridge.");
const sentinelDatabaseUrl =
  "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test";
if (process.env.DATABASE_URL !== sentinelDatabaseUrl) {
  throw new Error(
    "The optimized E2E database bridge requires its exact local sentinel database URL."
  );
}

const database = new PGlite(dataDir);
globalThis.workoutTrackerPgliteBridgeClient = database;
const nativeFetch = globalThis.fetch;

function postgresArray(values) {
  return `{${values
    .map((value) => {
      if (value == null) return "NULL";
      if (Array.isArray(value)) return postgresArray(value);
      const text = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return `"${text}"`;
    })
    .join(",")}}`;
}

function rawPostgresText(value, dataTypeID) {
  if (value == null) return null;
  if (dataTypeID === 114 || dataTypeID === 3802) return JSON.stringify(value);
  if (dataTypeID === 1082 && value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return postgresArray(value);
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  return JSON.stringify(value);
}

async function execute(query) {
  const result = await database.query(query.query, query.params ?? [], {
    rowMode: "array",
  });
  const rows = result.rows.map((row) =>
    row.map((value, index) =>
      rawPostgresText(value, result.fields[index]?.dataTypeID)
    )
  );
  return {
    command: query.query.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "",
    fields: result.fields.map((field) => ({
      name: field.name,
      dataTypeID: field.dataTypeID,
    })),
    rowCount: result.affectedRows || rows.length,
    rows,
  };
}

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.test/sql")) {
    return nativeFetch(input, init);
  }

  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const response = Array.isArray(body.queries)
      ? { results: await Promise.all(body.queries.map(execute)) }
      : await execute(body);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object"
          ? Object.fromEntries(
              [
                "severity",
                "code",
                "detail",
                "hint",
                "position",
                "where",
                "schema",
                "table",
                "column",
                "dataType",
                "constraint",
              ].flatMap((key) =>
                key in error && typeof error[key] === "string"
                  ? [[key, error[key]]]
                  : []
              )
            )
          : {}),
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }
};
