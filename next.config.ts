import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dkg.js has an incomplete dependency tree (assertion-tools) and must be
  // loaded from node_modules at runtime, not bundled by Turbopack
  serverExternalPackages: ["dkg.js", "assertion-tools"]
};

export default nextConfig;
