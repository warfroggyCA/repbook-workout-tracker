import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RestAlertPreferenceControl } from "@/components/settings/rest-alert-preference-control";

describe("RestAlertPreferenceControl", () => {
  it("renders a sound default, exact device scope, and a cue test path", () => {
    const html = renderToStaticMarkup(<RestAlertPreferenceControl />);
    expect(html).toContain("Rest timer alert");
    expect(html).toContain("Visual only");
    expect(html).toMatch(/aria-checked="true"[\s\S]*>Sound<\/span>/);
    expect(html).toContain("Countdown ticks + finish alarm (default)");
    expect(html).toContain("Sound + vibration");
    expect(html).toContain("Test selected cue");
    expect(html).toContain("only to this browser/device");
    expect(html).toContain("on-screen ready state does not depend on");
  });
});
