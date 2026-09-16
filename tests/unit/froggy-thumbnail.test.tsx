import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { FroggyThumbnail } from "@/components/exercises/froggy-thumbnail";
import { FROGGY_FORMS } from "@/lib/froggy-form-config";

describe("Froggy icon delivery", () => {
  it("keeps animation and video requests out of initial markup", () => {
    for (const config of Object.values(FROGGY_FORMS)) {
      const html = renderToStaticMarkup(<FroggyThumbnail config={config} paused={false} />);
      expect(html).toContain(`${config.media}/${config.thumbnail}`);
      expect(html).toContain('loading="lazy"');
      expect(html).not.toContain(".mp4");
      if (config.animatedThumbnail) expect(html).not.toContain(config.animatedThumbnail);
    }
  });
  it("ships complete, small transparent sprite sheets for the opted-in icons", async () => {
    const configured = Object.values(FROGGY_FORMS).filter(config => config.animatedThumbnail);
    expect(configured.map(config => config.title).sort()).toEqual(["Incline Dumbbell Curl", "Kettlebell Goblet Squat", "Seated overhead triceps extension"]);
    for (const config of configured) {
      const path = join(process.cwd(), "public", config.animatedThumbnail!);
      expect(statSync(path).size).toBeLessThan(200_000);
      const metadata = await sharp(path).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.width).toBe(8 * 128);
      expect(metadata.height).toBe(9 * 128);
      expect(metadata.hasAlpha).toBe(true);
    }
  });
});
