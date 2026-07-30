import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
const pgliteDir = process.env.PGLITE_DIR ?? "./.pglite";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  ...(url
    ? { dbCredentials: { url } }
    : // Embedded local database for development without a Neon account.
      { driver: "pglite", dbCredentials: { url: pgliteDir } }),
  strict: true,
  verbose: true,
});
