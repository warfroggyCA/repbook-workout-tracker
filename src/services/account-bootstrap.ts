import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type { CurrentUser } from "@/lib/user";

export type AccountBootstrapCheckpoint = (
  boundary: string
) => void | Promise<void>;

type AccountBootstrapRow = Record<string, unknown> & {
  user_id: string;
  email: string;
  name: string | null;
  profile_id: string;
  age_range: string | null;
  experience: CurrentUser["profile"]["experience"];
  goals: string[];
  session_length_min: number;
  weekly_frequency: number;
  unit: CurrentUser["profile"]["unit"];
  timezone: string;
  font_size: string;
  coaching_prefs: CurrentUser["profile"]["coachingPrefs"];
  setup_completed_at: Date | string | null;
  setup_state: CurrentUser["profile"]["setupState"];
  profile_created_at: Date | string;
  profile_updated_at: Date | string;
};

function databaseDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toCurrentUser(row: AccountBootstrapRow): CurrentUser {
  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    profile: {
      id: row.profile_id,
      userId: row.user_id,
      ageRange: row.age_range,
      experience: row.experience,
      goals: row.goals,
      sessionLengthMin: row.session_length_min,
      weeklyFrequency: row.weekly_frequency,
      unit: row.unit,
      timezone: row.timezone,
      fontSize: row.font_size,
      coachingPrefs: row.coaching_prefs,
      setupCompletedAt:
        row.setup_completed_at == null
          ? null
          : databaseDate(row.setup_completed_at),
      setupState: row.setup_state,
      createdAt: databaseDate(row.profile_created_at),
      updatedAt: databaseDate(row.profile_updated_at),
    },
  };
}

export async function bootstrapUserAccount(
  db: Db,
  identity: { email: string; name?: string | null },
  checkpoint: AccountBootstrapCheckpoint = () => undefined
): Promise<CurrentUser> {
  const email = identity.email.trim().toLowerCase();
  await checkpoint("account-ready");
  const [existingRow] = resultRows<AccountBootstrapRow>(await db.execute(sql`
    SELECT
      u.id AS user_id,
      u.email,
      u.name,
      p.id AS profile_id,
      p.age_range,
      p.experience,
      p.goals,
      p.session_length_min,
      p.weekly_frequency,
      p.unit,
      p.timezone,
      p.font_size,
      p.coaching_prefs,
      p.setup_completed_at,
      p.setup_state,
      p.created_at AS profile_created_at,
      p.updated_at AS profile_updated_at
    FROM users u
    INNER JOIN user_profiles p ON p.user_id = u.id
    WHERE u.email = ${email}
    LIMIT 1
  `));
  if (existingRow) return toCurrentUser(existingRow);

  await checkpoint("account-missing");
  const [row] = resultRows<AccountBootstrapRow>(await db.execute(sql`
    WITH account_user AS (
      INSERT INTO users (email, name)
      VALUES (${email}, ${identity.name ?? null})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id, email, name
    ), account_profile AS (
      INSERT INTO user_profiles (user_id)
      SELECT id FROM account_user
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING *
    )
    SELECT
      u.id AS user_id,
      u.email,
      u.name,
      p.id AS profile_id,
      p.age_range,
      p.experience,
      p.goals,
      p.session_length_min,
      p.weekly_frequency,
      p.unit,
      p.timezone,
      p.font_size,
      p.coaching_prefs,
      p.setup_completed_at,
      p.setup_state,
      p.created_at AS profile_created_at,
      p.updated_at AS profile_updated_at
    FROM account_user u
    INNER JOIN account_profile p ON p.user_id = u.id
  `));
  await checkpoint("account-upserted");
  if (!row) throw new Error("The account bootstrap statement returned no account.");
  return toCurrentUser(row);
}
