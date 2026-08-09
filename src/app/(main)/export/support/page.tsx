import { SupportBundleBuilder } from "@/components/export/support-bundle-builder";
import { PRODUCT_VERSION } from "@/lib/product-version";

export default function SupportBundlePage() {
  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Owner-controlled diagnostics
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Support bundle
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Select one problem, remove any optional context, inspect the exact
            final JSON, and deliberately download it. Repbook never sends the
            bundle for you.
          </p>
        </header>
        <SupportBundleBuilder appVersion={PRODUCT_VERSION} />
      </div>
    </main>
  );
}
