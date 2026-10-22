import type { MetadataRoute } from "next";
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_FORMAL_NAME,
  PRODUCT_SHORT_NAME,
} from "@/lib/product-identity";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_FORMAL_NAME,
    short_name: PRODUCT_SHORT_NAME,
    description: PRODUCT_DESCRIPTION,
    start_url: "/today",
    display: "standalone",
    background_color: "#f4f6ef",
    theme_color: "#f4f6ef",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
