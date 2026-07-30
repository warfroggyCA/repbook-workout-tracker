import type { Metadata } from "next";
import {
  isDevLoginEnabled,
  isGitHubAuthConfigured,
  isPreviewLoginEnabled,
  signIn,
} from "@/lib/auth";
import { ProductLockup } from "@/components/nav/product-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRODUCT_NAME, PRODUCT_PROMISE } from "@/lib/product-identity";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  const hasGitHub = isGitHubAuthConfigured();
  const isDev = isDevLoginEnabled();
  const isPreview = isPreviewLoginEnabled();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm border-t-4 border-t-primary shadow-[var(--shadow-soft)]">
        <CardHeader className="gap-4">
          <ProductLockup />
          <div className="border-l-2 border-primary/40 pl-3">
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {PRODUCT_PROMISE}
            </p>
            <CardTitle className="mt-1">Sign in</CardTitle>
            <CardDescription className="mt-1">
              Continue your private training record in {PRODUCT_NAME}.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasGitHub && (
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/today" });
              }}
            >
              <Button type="submit" className="w-full">
                Sign in with GitHub
              </Button>
            </form>
          )}
          {isDev && (
            <form
              className="flex flex-col gap-2"
              action={async (formData: FormData) => {
                "use server";
                await signIn("dev-login", {
                  email: isPreview
                    ? undefined
                    : String(formData.get("email") ?? ""),
                  redirectTo: "/today",
                });
              }}
            >
              {!isPreview && (
                <Input
                  name="email"
                  type="email"
                  placeholder="allowlisted email"
                  required
                />
              )}
              <Button type="submit" variant="outline" className="w-full">
                {isPreview ? "Enter disposable preview" : "Dev login"}
              </Button>
              {isPreview && (
                <p className="text-xs text-muted-foreground">
                  Uses synthetic preview data only. Nothing here changes your
                  production training record.
                </p>
              )}
            </form>
          )}
          {!hasGitHub && !isDev && (
            <p className="text-sm text-muted-foreground">
              No sign-in provider configured. Set AUTH_GITHUB_ID /
              AUTH_GITHUB_SECRET.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
