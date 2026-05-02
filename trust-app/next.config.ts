import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // standalone output bundles a minimal node_modules subset alongside
  // the .next build into .next/standalone. Required for the docker
  // image: the runtime stage copies that directory and runs
  // `node server.js` without a global node_modules.
  output: "standalone",
};

export default config;
