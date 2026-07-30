const DATABASE_NAME_PATTERN = /(test|disposable)/i;

function targetIdentity(url) {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

export function validateCoreLoopNeonTarget({
  disposableUrl,
  productionUrl,
  allowWrites,
  migrated,
  runtimeEnvironment,
}) {
  if (!disposableUrl?.trim()) {
    throw new Error("DISPOSABLE_NEON_DATABASE_URL is required.");
  }
  if (!allowWrites) {
    throw new Error("The explicit --allow-writes flag is required.");
  }
  if (runtimeEnvironment === "production") {
    throw new Error("The disposable Neon check cannot run in a production runtime.");
  }

  let parsed;
  try {
    parsed = new URL(disposableUrl.trim());
  } catch {
    throw new Error("DISPOSABLE_NEON_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DISPOSABLE_NEON_DATABASE_URL must use PostgreSQL.");
  }
  if (!parsed.hostname.endsWith(".neon.tech")) {
    throw new Error("The core-loop release check requires a real Neon host.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error("The Neon database name must contain test or disposable.");
  }
  if (/(prod|production|main)/i.test(databaseName)) {
    throw new Error("A production-like database name is never accepted.");
  }

  if (productionUrl?.trim()) {
    let production;
    try {
      production = new URL(productionUrl.trim());
    } catch {
      throw new Error("DATABASE_URL is set but is not a valid comparison URL.");
    }
    if (targetIdentity(production) === targetIdentity(parsed)) {
      throw new Error("The disposable target matches DATABASE_URL and is refused.");
    }
  }

  return {
    databaseUrl: parsed.toString(),
    databaseName,
    migrated: Boolean(migrated),
  };
}

export function prepareCoreLoopNeonRuntime(input, environment = process.env) {
  const target = validateCoreLoopNeonTarget(input);
  environment.DATABASE_URL = target.databaseUrl;
  return target;
}

export function coreLoopNeonFlags(argv) {
  const known = new Set(["--allow-writes", "--migrated"]);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument ${unknown[0]}.`);
  }
  return {
    allowWrites: argv.includes("--allow-writes"),
    migrated: argv.includes("--migrated"),
  };
}
