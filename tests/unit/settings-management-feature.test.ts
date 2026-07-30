import { afterEach, describe, expect, it } from "vitest";
import {
  completedSetupRedirectTarget,
  isSettingsManagementEnabled,
} from "@/lib/settings-management-feature";

const original = process.env.SETTINGS_MANAGEMENT_ENABLED;

afterEach(() => {
  if (original == null) delete process.env.SETTINGS_MANAGEMENT_ENABLED;
  else process.env.SETTINGS_MANAGEMENT_ENABLED = original;
});

describe("Settings management release switch", () => {
  it("defaults off and sends completed setup back to ordinary Settings", () => {
    delete process.env.SETTINGS_MANAGEMENT_ENABLED;
    expect(isSettingsManagementEnabled()).toBe(false);
    expect(completedSetupRedirectTarget()).toBe("/settings");
  });

  it("accepts only the exact enabled value", () => {
    process.env.SETTINGS_MANAGEMENT_ENABLED = "TRUE";
    expect(isSettingsManagementEnabled()).toBe(false);
    process.env.SETTINGS_MANAGEMENT_ENABLED = "true";
    expect(isSettingsManagementEnabled()).toBe(true);
    expect(completedSetupRedirectTarget()).toBe("/settings/setup");
  });
});
