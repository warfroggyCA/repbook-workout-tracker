import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel supplies one stable identifier per deployment. Next uses it to
  // detect an older installed-app document talking to a newer server and
  // performs a full navigation before incompatible Server Actions can mix.
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
  // PGlite (embedded local dev DB) loads its WASM from disk; bundling breaks it.
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value:
              "browsing-topics=(), camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
