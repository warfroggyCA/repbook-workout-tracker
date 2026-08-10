import { getDb } from "@/db";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_EMAIL,
} from "./v2-h02-cadence-targets-time";

async function main() {
  const db = await getDb();
  // The browser report uses the real server clock. Keep this disposable
  // fixture's calendar shape stable relative to that clock so it does not
  // become a date-based time bomb after the package evidence date.
  const fixture = await seedV2H02CadenceTargetsTime(db, new Date());
  console.log(
    `Seeded H02 cadence and target fixture for ${V2_H02_EMAIL} (${fixture.userId}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
