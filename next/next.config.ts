import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Desktop packaging (portable / Electron) runs the traced standalone
  // server (`node server.js`) instead of `next start`, which requires the
  // build to emit `.next/standalone`. No effect on `next dev`.
  output: "standalone",
};

export default nextConfig;
