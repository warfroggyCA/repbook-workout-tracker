import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Slider } from "@/components/ui/slider";

describe("Slider", () => {
  it("renders one thumb for one numeric value", () => {
    const html = renderToStaticMarkup(
      <Slider min={0} max={10} value={5} onValueChange={() => undefined} />
    );

    expect(html.match(/data-slot="slider-thumb"/g)).toHaveLength(1);
    expect(html).toContain("size-11");
  });

  it("keeps one thumb per value for an explicit range", () => {
    const html = renderToStaticMarkup(
      <Slider min={0} max={10} value={[3, 7]} onValueChange={() => undefined} />
    );

    expect(html.match(/data-slot="slider-thumb"/g)).toHaveLength(2);
  });
});
