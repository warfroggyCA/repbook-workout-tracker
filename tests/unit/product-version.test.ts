import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { PRODUCT_VERSION } from "@/lib/product-version";

describe("product version", () => {
  it("uses the package release version as its single source", () => {
    expect(PRODUCT_VERSION).toBe(packageMetadata.version);
    expect(PRODUCT_VERSION).toBe("2.2.0");
  });
});
