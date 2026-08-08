import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function ExportPage() {
  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="mb-1">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Portable evidence
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Export
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Take a copy of the records you own, with their limits and
            relationships made clear.
          </p>
        </header>

        <Card>
        <CardHeader>
          <CardTitle>Versioned analysis package</CardTitle>
          <CardDescription>
            Choose one question and preview the exact purpose-bounded JSON
            before downloading it. Repbook never sends the package for you and
            retains only a 30-day manifest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            render={<a href="/export/analysis" />}
            nativeButton={false}
            variant="outline"
          >
            Prepare analysis package
          </Button>
        </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <CardTitle>Coaching brief (Markdown)</CardTitle>
          <CardDescription>
            A readable summary to paste into Claude, ChatGPT, or hand to a
            coach. Includes what data is missing so nothing gets invented.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            render={<a href="/api/export/markdown?weeks=4" target="_blank" />}
            nativeButton={false}
            variant="outline"
          >
            Last 4 weeks
          </Button>
          <Button
            render={<a href="/api/export/markdown?weeks=8" target="_blank" />}
            nativeButton={false}
            variant="outline"
          >
            Last 8 weeks
          </Button>
          <Button
            render={
              <a href="/api/export/markdown?weeks=4&download=1" download />
            }
            nativeButton={false}
            variant="outline"
          >
            Download .md
          </Button>
        </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <CardTitle>Spreadsheet (CSV)</CardTitle>
          <CardDescription>
            Set-level history, recovery records, activities, and saved workout
            Coach conversations for spreadsheet analysis.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            render={<a href="/api/export/csv?entity=sets&weeks=all" download />}
            nativeButton={false}
            variant="outline"
          >
            All sets
          </Button>
          <Button
            render={<a href="/api/export/csv?entity=pain&weeks=all" download />}
            nativeButton={false}
            variant="outline"
          >
            Pain & fatigue
          </Button>
          <Button
            render={
              <a href="/api/export/csv?entity=activities&weeks=all" download />
            }
            nativeButton={false}
            variant="outline"
          >
            Health activities
          </Button>
          <Button
            render={<a href="/api/export/csv?entity=coach&weeks=all" download />}
            nativeButton={false}
            variant="outline"
          >
            Workout Coach conversations
          </Button>
        </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <CardTitle>Full backup (JSON)</CardTitle>
          <CardDescription>
            One verified point-in-time copy of active and archived data with
            original ids and relationships, in the same format used by Recovery.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            render={<a href="/api/export/json" download />}
            nativeButton={false}
            variant="outline"
          >
            Download backup
          </Button>
        </CardContent>
        </Card>
      </div>
    </main>
  );
}
