import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @arkivate/core ships TypeScript source; only import it from server code (it reads secrets).
  transpilePackages: ["@arkivate/core"],
};

export default nextConfig;
