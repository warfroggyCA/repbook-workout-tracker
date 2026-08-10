import { AnalysisPackageBuilder } from "@/components/export/analysis-package-builder";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { listAnalysisPackageManifests } from "@/services/analysis-package";

export default async function AnalysisPackagePage() {
  const user = await getCurrentUser();
  const manifests = await listAnalysisPackageManifests(await getDb(), user.id);
  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Owner-controlled portability
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Analysis package
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Build one purpose-bounded, versioned copy of the evidence needed
            for your selected question. Repbook shows the exact JSON before
            download and never sends it to an external service.
          </p>
        </header>
        <AnalysisPackageBuilder initialManifests={manifests} />
      </div>
    </main>
  );
}
