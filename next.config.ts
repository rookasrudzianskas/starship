import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      {
        // Earth imagery is large and rarely changes, but its file names carry no version: keep it for a day, then
        // revalidate in the background, instead of the default revalidation on every visit.
        source: "/earth/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        // The manifest describes the imagery, so it is checked on every visit (a cheap 304 when unchanged): a cached
        // manifest must never describe files that have since been replaced. A later rule overrides an earlier one.
        source: "/earth/manifest.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

export default nextConfig;
