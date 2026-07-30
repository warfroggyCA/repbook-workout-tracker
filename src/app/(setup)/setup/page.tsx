import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/user";
import { firstIncompleteStep } from "@/lib/setup-steps";
import { completedSetupRedirectTarget } from "@/lib/settings-management-feature";

/**
 * /setup resumes at the first step the user hasn't completed. Completed
 * accounts never re-enter first-time onboarding — they are sent to the safe
 * Settings review destination instead.
 */
export default async function SetupIndexPage() {
  const user = await getCurrentUser();
  if (user.profile.setupCompletedAt != null) {
    redirect(completedSetupRedirectTarget());
  }
  redirect(`/setup/${firstIncompleteStep(user.profile.setupState.completedSteps)}`);
}
