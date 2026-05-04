// trust-app/next.config.js
//
// Build-target shim. Reads KLIO_BUILD_TARGET={local,public} and
// configures Next.js so that only the matching route group ships
// in the bundle. See docs/plans/2026-05-04-trust-app-build-targets-design.md.
//
// Section A (this commit) just establishes the env-var read + the
// "output: standalone" needed by the Dockerfile. Webpack exclusion
// rules land in Section C.

/** @type {string} */
const TARGET = process.env.KLIO_BUILD_TARGET || "local";

if (!["local", "public"].includes(TARGET)) {
  throw new Error(
    `KLIO_BUILD_TARGET must be 'local' or 'public'; got '${TARGET}'. ` +
      `Use npm run build:local or npm run build:public.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // standalone output bundles a minimal node_modules subset alongside
  // the .next build into .next/standalone. Required for the docker
  // image: the runtime stage copies that directory and runs
  // `node server.js` without a global node_modules.
  output: "standalone",
};

console.log(`[next.config] KLIO_BUILD_TARGET=${TARGET}`);

module.exports = nextConfig;
