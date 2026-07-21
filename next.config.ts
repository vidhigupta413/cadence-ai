import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @mediapipe/pose ships a Closure-compiled IIFE (not an ES module).
  // transpilePackages forces Next.js to process it through SWC so named
  // imports resolve correctly in both Webpack and Turbopack builds.
  transpilePackages: ["@mediapipe/pose"],

  async headers() {
    return [
      {
        // Required for SharedArrayBuffer / WASM threading used by MediaPipe.
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy",  value: "require-corp" },
        ],
      },
      {
        // Serve MediaPipe WASM binaries with the correct MIME type.
        source: "/mediapipe/pose/:file*.wasm",
        headers: [
          { key: "Content-Type", value: "application/wasm" },
        ],
      },
    ];
  },
};

export default nextConfig;
