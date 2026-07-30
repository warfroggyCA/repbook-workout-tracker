import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { Badge } from "@/components/ui/badge";
import { formatRelativeDay } from "@/lib/dates";

export default async function AuditPage() {
  const user = await getCurrentUser();
  const db = await getDb();
  const entries = await db.query.auditLogs.findMany({
    where: eq(auditLogs.userId, user.id),
    orderBy: desc(auditLogs.createdAt),
    limit: 100,
  });

  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Audit history</h1>
      <p className="text-sm text-muted-foreground">
        Every change to your plan and every decision, with what caused it.
      </p>
      <div className="flex flex-col gap-2">
        {entries.map((e) => (
          <div key={e.id} className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline">{e.actorType}</Badge>
              <span className="text-xs text-muted-foreground">
                {formatRelativeDay(e.createdAt, user.profile.timezone)}
              </span>
            </div>
            <p className="mt-1 text-sm">{e.summary}</p>
            <p className="text-xs text-muted-foreground">{e.action}</p>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        )}
      </div>
    </main>
  );
}
