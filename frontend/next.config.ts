import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @arkivate/core ships TypeScript source. Import only "@arkivate/core", never
  // "@arkivate/core/server" (it reads env and private keys).
  transpilePackages: ["@arkivate/core"],
};

export default nextConfig;
