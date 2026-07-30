import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { FontSizeInitializer } from "@/components/settings/font-size-initializer";
import { StateNotice } from "@/components/ui/state-notice";
import { isPhase1FoundationDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { normalizeFontSize } from "@/lib/font-size";
import { getCurrentUser } from "@/lib/user";
import { WORKOUT_EXPERIENCE_STATES } from "@/lib/workout-experience-foundation";

export default async function Phase1FoundationPage() {
  if (!isPhase1FoundationDisposableAcceptanceRuntime()) {
    notFound();
  }
  const user = await getCurrentUser();

  return (
    <>
      <FontSizeInitializer profileSize={normalizeFontSize(user.profile.fontSize)} />
      <main
        id="phase1-foundation-proof"
        className="mx-auto grid max-w-xl gap-3 p-4"
      >
        <h1 className="text-2xl font-semibold">Workout experience state foundation</h1>
        {WORKOUT_EXPERIENCE_STATES.map((state) => (
          <StateNotice
            key={state}
            state={state}
            title={`${state.replace("_", " ")} — a long status title that must wrap safely`}
            description="The durable record remains on this device until the named action succeeds."
            action={<Button size="touch">Retry this record safely</Button>}
          />
        ))}
        <Button size="icon-touch" aria-label="Open status details">
          ?
        </Button>
      </main>
    </>
  );
}
