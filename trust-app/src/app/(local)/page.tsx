// trust-app/src/app/(local)/page.tsx
//
// Local-mode root: a user who pulls the trust-app via
// `npx @klio-tech/klio init` and opens http://127.0.0.1:3000
// expects to see their memories, not marketing copy. Redirect to
// the dashboard's home view. This file is included only when
// KLIO_BUILD_TARGET=local; the public build excludes the (local)/
// group entirely (see next.config.js).

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/memories");
}
