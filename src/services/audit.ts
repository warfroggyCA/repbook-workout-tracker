import type { Db } from "@/db";
import { auditLogs } from "@/db/schema";

type AuditInput = {
  userId: string;
  actorType: "user" | "rule" | "ai" | "system";
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
  causeRef?: Record<string, unknown>;
  idempotencyKey?: string;
};

export async function audit(db: Db, input: AuditInput): Promise<void> {
  const statement = db.insert(auditLogs).values(input);
  if (input.idempotencyKey) {
    await statement.onConflictDoNothing();
    return;
  }
  await statement;
}
