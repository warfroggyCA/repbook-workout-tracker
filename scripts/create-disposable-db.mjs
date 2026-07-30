import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, ...valueParts] = argument.replace(/^--/, "").split("=");
    return [name, valueParts.join("=")];
  })
);

const mode = argumentsByName.get("mode") || "fresh";
if (mode !== "fresh" && mode !== "clone") {
  throw new Error("Use --mode=fresh or --mode=clone.");
}

const targetDir = await mkdtemp(join(tmpdir(), `workout-tracker-${mode}-`));

if (mode === "fresh") {
  const client = new PGlite(targetDir);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await client.close();
} else {
  const sourceDir = resolve(argumentsByName.get("source") || "./.pglite");
  if (sourceDir === resolve(targetDir)) {
    throw new Error("The disposable target cannot be the source database.");
  }
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    await cp(join(sourceDir, entry.name), join(targetDir, entry.name), {
      recursive: entry.isDirectory(),
    });
  }

  const push = spawnSync("npm", ["run", "db:push", "--", "--force"], {
    cwd: process.cwd(),
    env: { ...process.env, PGLITE_DIR: targetDir },
    stdio: "inherit",
  });
  if (push.error) throw push.error;
  if (push.status !== 0) {
    throw new Error(`Schema push failed with status ${push.status}.`);
  }
}

process.stdout.write(
  `${JSON.stringify({ mode, pgliteDir: targetDir, name: basename(targetDir) })}\n`
);
