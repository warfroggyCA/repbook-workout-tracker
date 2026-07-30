// Intent suite: proves returning accounts are read-only and first-login/profile
// repair races converge on one complete owned account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userProfiles, users } from "@/db/schema";
import { authorizedSessionIdentity } from "@/lib/session-authorization";
import { bootstrapUserAccount } from "@/services/account-bootstrap";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  failAfterBoundary,
  type TestDatabase,
} from "../helpers/database";

describe("account bootstrap ownership and no-rewrite invariants", () => {
  let database: TestDatabase;

  function queryText(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.map((call: unknown[]) =>
      String(call[0]).replace(/\s+/g, " ").trim()
    );
  }

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await database.close();
  });

  it("uses one lookup and one atomic upsert for the first login", async () => {
    const checkpoints: string[] = [];
    const query = vi.spyOn(database.client, "query");

    const account = await bootstrapUserAccount(
      database.db,
      { email: "  FIRST-LOGIN@EXAMPLE.COM  ", name: "First Login" },
      (boundary) => {
        checkpoints.push(boundary);
      }
    );
    const statements = queryText(query);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^select /i);
    expect(statements[0]).not.toMatch(/\b(insert|update|delete|merge)\b/i);
    expect(query.mock.calls[0]?.[1]).toContain("first-login@example.com");
    expect(statements[1]).toMatch(/\binsert into users\b/i);
    expect(statements[1]).toMatch(/\binsert into user_profiles\b/i);
    expect(checkpoints).toEqual([
      "account-ready",
      "account-missing",
      "account-upserted",
    ]);
    expect(account.email).toBe("first-login@example.com");
    expect(account.name).toBe("First Login");
    expect(account.profile.userId).toBe(account.id);
  });

  it("converges eight simultaneous first requests on one complete account", async () => {
    const participants = 8;
    const missing = createStartBarrier(participants);
    const results = await Promise.all(
      Array.from({ length: participants }, () =>
        bootstrapUserAccount(
          database.db,
          { email: "first-login@example.com", name: "First Login" },
          async (boundary) => {
            if (boundary === "account-missing") await missing();
          }
        )
      )
    );

    expect(new Set(results.map(({ id }) => id))).toEqual(
      new Set([results[0].id])
    );
    expect(new Set(results.map(({ profile }) => profile.id))).toEqual(
      new Set([results[0].profile.id])
    );
    expect(await database.db.select().from(users)).toHaveLength(1);
    expect(await database.db.select().from(userProfiles)).toHaveLength(1);
  });

  it("returns an existing account unchanged with one read-only request", async () => {
    const original = await bootstrapUserAccount(database.db, {
      email: "existing@example.com",
      name: "Original Name",
    });
    const query = vi.spyOn(database.client, "query");
    const checkpoints: string[] = [];

    const account = await bootstrapUserAccount(
      database.db,
      { email: "  EXISTING@EXAMPLE.COM ", name: "Ignored Replacement" },
      (boundary) => {
        checkpoints.push(boundary);
      }
    );
    const statements = queryText(query);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^select /i);
    expect(statements[0]).not.toMatch(/\b(insert|update|delete|merge)\b/i);
    expect(query.mock.calls[0]?.[1]).toContain("existing@example.com");
    expect(checkpoints).toEqual(["account-ready"]);
    expect(account).toEqual(original);
    expect(account.email).toBe("existing@example.com");
    expect(account.name).toBe("Original Name");
  });

  it("converges eight simultaneous missing-profile repairs on shared ids", async () => {
    const [user] = await database.db.insert(users).values({
      email: "profile-race@example.com",
      name: "Profile Race",
    }).returning();
    const participants = 8;
    const missing = createStartBarrier(participants);
    const results = await Promise.all(
      Array.from({ length: participants }, () =>
        bootstrapUserAccount(
          database.db,
          { email: "profile-race@example.com", name: "Profile Race" },
          async (boundary) => {
            if (boundary === "account-missing") await missing();
          }
        )
      )
    );

    expect(new Set(results.map(({ id }) => id))).toEqual(new Set([user.id]));
    expect(new Set(results.map(({ profile }) => profile.id))).toEqual(
      new Set([results[0].profile.id])
    );
    expect(await database.db.select().from(users)).toHaveLength(1);
    expect(await database.db.select().from(userProfiles)).toHaveLength(1);
  });

  it("writes nothing when failure is injected before or after a missing lookup", async () => {
    await expect(
      bootstrapUserAccount(
        database.db,
        { email: "before-write@example.com" },
        failAfterBoundary("account-ready")
      )
    ).rejects.toThrow("account-ready");
    expect(await database.db.select().from(users)).toHaveLength(0);
    expect(await database.db.select().from(userProfiles)).toHaveLength(0);

    await expect(
      bootstrapUserAccount(
        database.db,
        { email: "after-lookup@example.com" },
        failAfterBoundary("account-missing")
      )
    ).rejects.toThrow("account-missing");
    expect(await database.db.select().from(users)).toHaveLength(0);
    expect(await database.db.select().from(userProfiles)).toHaveLength(0);
  });

  it("leaves one complete account when failure follows the atomic upsert", async () => {
    await expect(
      bootstrapUserAccount(
        database.db,
        { email: "after-write@example.com" },
        failAfterBoundary("account-upserted")
      )
    ).rejects.toThrow("account-upserted");
    expect(await database.db.select().from(users)).toHaveLength(1);
    expect(await database.db.select().from(userProfiles)).toHaveLength(1);
  });

  it("applies allowlist revocation to the next request", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "revoked@example.com");
    const { isAllowedEmail } = await import("@/lib/allowlist");
    expect(isAllowedEmail("revoked@example.com")).toBe(true);
    expect(
      authorizedSessionIdentity({ user: { email: "revoked@example.com" } })
    ).toEqual({ email: "revoked@example.com", name: null });

    vi.stubEnv("ALLOWED_EMAILS", "replacement@example.com");
    expect(isAllowedEmail("revoked@example.com")).toBe(false);
    expect(isAllowedEmail("replacement@example.com")).toBe(true);
    expect(
      authorizedSessionIdentity({ user: { email: "revoked@example.com" } })
    ).toBeNull();
  });
});
