import "server-only";

/**
 * Release switch for the Settings-launched equipment management and
 * returning-user setup review (UI-002, UI-005–UI-007). Server-authoritative
 * and default-off: absent or any value other than the exact string "true"
 * keeps every new entry point hidden and every new route unavailable.
 */
export function isSettingsManagementEnabled(): boolean {
  return process.env.SETTINGS_MANAGEMENT_ENABLED === "true";
}

/**
 * Where a completed account lands when it visits first-time setup. While the
 * review feature is disabled during rollout, completed accounts go to plain
 * Settings rather than the old setup review/activation path.
 */
export function completedSetupRedirectTarget(): "/settings/setup" | "/settings" {
  return isSettingsManagementEnabled() ? "/settings/setup" : "/settings";
}
