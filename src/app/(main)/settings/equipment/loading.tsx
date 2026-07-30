import { Skeleton } from "@/components/ui/skeleton";

export default function ManageEquipmentLoading() {
  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8"
      aria-busy="true"
      aria-label="Loading equipment management"
    >
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <p className="sr-only" role="status">
        Loading your equipment inventory…
      </p>
    </main>
  );
}
