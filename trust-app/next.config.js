// trust-app/next.config.js
//
// Build-target shim. KLIO_BUILD_TARGET={local,public} selects which
// route group ships in the bundle.
//
// Section A established the env-var read and standalone output.
// Section C originally specified a webpack rule using `ignore-loader`,
// but Next.js 16 enables Turbopack by default and ignores `webpack:`
// config — Turbopack errors loudly when both are present. Rather than
// mix two bundlers, the route-group exclusion lives in a prebuild
// step (scripts/select-target.mjs) that hides the unwanted group's
// directory from the FS router by renaming it to `__klio_hidden__*`,
// which Next treats as a private folder and never resolves as a
// route. scripts/restore-targets.mjs reverses the rename and is
// invoked unconditionally (success or failure) by the npm scripts so
// the working tree is always clean afterward.
//
// Bundle-isolation guardrail (scripts/check-bundle-isolation.mjs)
// runs against the produced .next/standalone tree and fails the
// build if any forbidden cross-target string leaked through.

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
  output: "standalone",
  reactStrictMode: true,
};

console.log(`[next.config] KLIO_BUILD_TARGET=${TARGET}`);

module.exports = nextConfig;
