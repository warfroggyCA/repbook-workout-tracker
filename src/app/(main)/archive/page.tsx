import Link from "next/link";
import {
  Archive,
  Database,
  Dumbbell,
  Footprints,
  Sparkles,
  Layers3,
  Trash2,
} from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { getArchiveList, type ArchiveRootEntityType } from "@/services/archive";
import { ArchiveRestoreButton } from "@/components/archive/archive-restore-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const filters = [
  { key: "all", label: "All", entityTypes: undefined, icon: Layers3 },
  {
    key: "workouts",
    label: "Workouts",
    entityTypes: ["workout_session", "sample_history"] as ArchiveRootEntityType[],
    icon: Dumbbell,
  },
  {
    key: "activities",
    label: "Activities",
    entityTypes: ["health_activity", "activity_history"] as ArchiveRootEntityType[],
    icon: Footprints,
  },
  {
    key: "sets",
    label: "Sets",
    entityTypes: ["completed_set"] as ArchiveRootEntityType[],
    icon: Archive,
  },
  {
    key: "imports",
    label: "Imports",
    entityTypes: ["history_import_batch"] as ArchiveRootEntityType[],
    icon: Database,
  },
  {
    key: "ai",
    label: "AI & Coach",
    entityTypes: ["ai_history"] as ArchiveRootEntityType[],
    icon: Sparkles,
  },
];

function countsText(counts: Record<string, number>) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`)
    .join(" · ");
}

function dateBoundary(value: string | undefined, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const selected = filters.find((item) => item.key === query.type) ?? filters[0];
  const user = await getCurrentUser();
  const db = await getDb();
  const items = await getArchiveList(
    db,
    user.id,
    selected.entityTypes,
    dateBoundary(query.from),
    dateBoundary(query.to, true)
  );

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <div className="flex items-center gap-2">
          <Archive className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Archive
          </h1>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Archived records are hidden from normal reports and coaching, but their
          original IDs, dates, details, relationships, and provenance are retained.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Archive record type">
        {filters.map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            render={<Link href={key === "all" ? "/archive" : `/archive?type=${key}`} />}
            nativeButton={false}
            size="sm"
            variant={selected.key === key ? "default" : "outline"}
          >
            <Icon className="size-4" /> {label}
          </Button>
        ))}
      </nav>

      <form className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        {selected.key !== "all" && (
          <input type="hidden" name="type" value={selected.key} />
        )}
        <label className="text-sm font-medium">
          Archived from
          <input
            type="date"
            name="from"
            defaultValue={query.from ?? ""}
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="text-sm font-medium">
          Archived through
          <input
            type="date"
            name="to"
            defaultValue={query.to ?? ""}
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <Button type="submit" size="sm">Apply dates</Button>
        <Button
          render={<Link href={selected.key === "all" ? "/archive" : `/archive?type=${selected.key}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
        >
          Clear
        </Button>
      </form>

      {items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <Archive className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 font-medium">Nothing archived here</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Records you archive will remain available for inspection and restore.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <Card
              key={item.operationId}
              id={`operation-${item.operationId}`}
              className="scroll-mt-4"
            >
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{item.summary}</CardTitle>
                      <Badge variant="secondary">
                        {item.rootType.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <CardDescription>
                      Archived {item.archivedAt.toLocaleString()}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ArchiveRestoreButton operationId={item.operationId} />
                    <Button
                      render={
                        <Link href={`/archive/${item.operationId}/delete`} />
                      }
                      nativeButton={false}
                      size="sm"
                      variant="destructive"
                    >
                      <Trash2 className="size-3.5" /> Delete permanently
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    "rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground",
                    !countsText(item.counts) && "hidden"
                  )}
                >
                  {countsText(item.counts)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Permanent deletion is available only from this Archive. It requires a new
        identity check, an exact linked-record preview, the typed irreversible
        confirmation, and a newly verified encrypted safety copy.
      </p>
    </main>
  );
}
