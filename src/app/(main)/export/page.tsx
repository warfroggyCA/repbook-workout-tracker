import { ChevronDown, Database, Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyCompleteReportButton } from "@/components/export/copy-complete-report-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  resolveTrainingBriefRange,
  TRAINING_BRIEF_RANGE_OPTIONS,
} from "@/lib/training-brief-range";

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{
    briefRange?: string | string[];
  }>;
}) {
  const { briefRange } = await searchParams;
  const { option: initialRange, selectedFromAllTime } =
    resolveTrainingBriefRange(briefRange);

  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="mb-1">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Your records
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Downloads &amp; backup
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Download a readable report or keep a full recovery copy of your
            Repbook data.
          </p>
        </header>

        <Card className="border-primary/50 bg-primary/3">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Complete AI report</CardTitle>
              <Badge>Recommended</Badge>
            </div>
            <CardDescription>
              Creates one all-time training report with instructions already
              written for an AI assistant, then copies it to your clipboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CopyCompleteReportButton />
          </CardContent>
        </Card>

        <Card id="training-brief">
          <CardHeader>
            <CardTitle>Training Brief</CardTitle>
            <CardDescription>
              A readable Markdown report for a coach or AI assistant. It covers
              the period you choose, includes supporting details and gaps, and
              is never sent anywhere by Repbook.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              action="/api/export/markdown"
              method="get"
              className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
            >
              <div>
                <label
                  htmlFor="training-brief-weeks"
                  className="text-sm font-medium"
                >
                  Period to summarize
                </label>
                <select
                  id="training-brief-weeks"
                  name="weeks"
                  defaultValue={String(initialRange.weeks)}
                  className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {TRAINING_BRIEF_RANGE_OPTIONS.map((option) => (
                    <option key={option.key} value={option.weeks}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {selectedFromAllTime && (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    History is showing all time. A readable brief is
                    intentionally bounded, so 12 weeks is selected. Choose a
                    different period if needed.
                  </p>
                )}
              </div>
              <input type="hidden" name="download" value="1" />
              <Button type="submit" className="min-h-11 sm:self-end">
                <Download className="size-4" aria-hidden="true" />
                Download training brief
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle>Back up all Repbook data</CardTitle>
            </div>
            <CardDescription>
              A complete JSON copy of active and archived records for recovery.
              It keeps original identities and relationships, but is not meant
              to be read like a report.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              render={<a href="/api/export/json" download />}
              nativeButton={false}
              variant="outline"
            >
              <Download className="size-4" aria-hidden="true" />
              Download full backup
            </Button>
          </CardContent>
        </Card>

        <details className="group rounded-xl border bg-card text-card-foreground shadow-sm">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-6 py-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="block font-semibold">Advanced exports</span>
              <span className="mt-1 block text-sm font-normal text-muted-foreground">
                Spreadsheets, analysis packages, and troubleshooting files.
              </span>
            </span>
            <ChevronDown
              className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <div className="grid gap-6 border-t px-6 py-5">
            <section aria-labelledby="spreadsheet-export-title">
              <div className="flex items-center gap-2">
                <FileText
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 id="spreadsheet-export-title" className="font-semibold">
                  Spreadsheet data (CSV)
                </h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Raw tables for spreadsheet work. They contain fewer
                relationships than the full backup.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  render={
                    <a href="/api/export/csv?entity=sets&weeks=all" download />
                  }
                  nativeButton={false}
                  variant="outline"
                >
                  Set data
                </Button>
                <Button
                  render={
                    <a href="/api/export/csv?entity=pain&weeks=all" download />
                  }
                  nativeButton={false}
                  variant="outline"
                >
                  Pain &amp; fatigue
                </Button>
                <Button
                  render={
                    <a
                      href="/api/export/csv?entity=activities&weeks=all"
                      download
                    />
                  }
                  nativeButton={false}
                  variant="outline"
                >
                  Activities
                </Button>
                <Button
                  render={
                    <a href="/api/export/csv?entity=coach&weeks=all" download />
                  }
                  nativeButton={false}
                  variant="outline"
                >
                  Coach conversations
                </Button>
              </div>
            </section>

            <section
              aria-labelledby="analysis-export-title"
              className="border-t pt-5"
            >
              <h2 id="analysis-export-title" className="font-semibold">
                Versioned analysis package
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Choose one analysis question, then preview the exact JSON before
                downloading it. Repbook never sends it for you.
              </p>
              <Button
                render={<a href="/export/analysis" />}
                nativeButton={false}
                variant="outline"
                className="mt-3"
              >
                Prepare analysis package
              </Button>
            </section>

            <section
              aria-labelledby="support-export-title"
              className="border-t pt-5"
            >
              <h2 id="support-export-title" className="font-semibold">
                Support bundle
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Choose one problem and preview a redacted troubleshooting file.
                Repbook never uploads it automatically.
              </p>
              <Button
                render={<a href="/export/support" />}
                nativeButton={false}
                variant="outline"
                className="mt-3"
              >
                Prepare support bundle
              </Button>
            </section>
          </div>
        </details>
      </div>
    </main>
  );
}
