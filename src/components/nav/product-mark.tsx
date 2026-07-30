import Link from "next/link";
import { Route } from "lucide-react";
import {
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
} from "@/lib/product-identity";
import { cn } from "@/lib/utils";

export function ProductGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary",
        className
      )}
    >
      <Route className="size-5" strokeWidth={2.2} />
    </span>
  );
}

export function ProductLockup({
  className,
  showDescriptor = true,
}: {
  className?: string;
  showDescriptor?: boolean;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <ProductGlyph />
      <span className="min-w-0 leading-none">
        <span className="block truncate text-lg font-semibold tracking-[-0.025em]">
          {PRODUCT_NAME}
        </span>
        {showDescriptor && (
          <span className="mt-1 block truncate text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {PRODUCT_DESCRIPTOR}
          </span>
        )}
      </span>
    </span>
  );
}

export function ProductHomeLink({
  href,
  collapsed = false,
  label = `${PRODUCT_NAME} home`,
  className,
}: {
  href: string;
  collapsed?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={collapsed ? PRODUCT_NAME : undefined}
      className={cn(
        "rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        collapsed ? "flex justify-center" : "block px-2",
        className
      )}
    >
      {collapsed ? <ProductGlyph /> : <ProductLockup />}
    </Link>
  );
}
