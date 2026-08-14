import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProgramLibrary } from "@/components/program/program-library";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { listProgramLibrary } from "@/services/program-library";

export default async function ProgramLibraryPage() {
  const user = await getCurrentUser();
  const db = await getDb();
  const programs = await listProgramLibrary(db, user.id);

  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <Button variant="ghost" render={<Link href="/program" />} nativeButton={false}>
          <ArrowLeft /> Back to Program
        </Button>
        <header className="mt-3 mb-5">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Saved routine sets</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Programs</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Keep separate named sets of routines and choose which one Today uses. Switching never rewrites completed workouts.
          </p>
        </header>
        {programs.length > 0 ? (
          <ProgramLibrary programs={programs} />
        ) : (
          <section className="rounded-2xl border bg-card p-5">
            <h2 className="font-semibold">No Programs yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">Import a routine set to create your first Program.</p>
            <Button className="mt-4" render={<Link href="/program/import?destination=new" />} nativeButton={false}>Import routines</Button>
          </section>
        )}
      </div>
    </main>
  );
}
