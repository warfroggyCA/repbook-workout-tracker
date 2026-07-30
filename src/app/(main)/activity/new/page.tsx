import Link from "next/link";
import { ArrowLeft, Footprints } from "lucide-react";
import { ActivityForm } from "@/components/activity/activity-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NewActivityPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <Button
          render={<Link href="/history" />}
          nativeButton={false}
          variant="ghost"
          className="-ml-2 mb-2"
        >
          <ArrowLeft className="size-4" /> History
        </Button>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
          Independent health activity
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          Record activity
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a walk, hike, run, or other activity for its actual date without
          changing your workout order or strength program.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Footprints className="size-5 text-primary" /> Activity details
          </CardTitle>
          <CardDescription>
            Duration is required. Add distance and other measurements only when
            you have them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityForm />
        </CardContent>
      </Card>
    </main>
  );
}
