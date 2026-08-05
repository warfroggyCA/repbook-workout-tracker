import { getDb } from "@/db";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_EMAIL,
} from "./v2-h02-cadence-targets-time";

async function main() {
  const db = await getDb();
  const fixture = await seedV2H02CadenceTargetsTime(db);
  console.log(
    `Seeded H02 cadence and target fixture for ${V2_H02_EMAIL} (${fixture.userId}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
