// trust-app/src/lib/system-banners.ts
//
// Server-side fetch of /v1/system/banners.
//
// The endpoint returns a list of UI-level prompts the dashboard
// should render to the authenticated user. v0.6.0 ships exactly
// one banner kind (`claim_email`); future kinds (e.g.,
// `update_available`) will be added by their producers and the
// `BannerKind` union widened in lockstep.
//
// Called from the (local)/layout.tsx server component on every
// dashboard render. The fetch uses `cache: "no-store"` because the
// unclaimed/claimed state can change between page loads — for
// example, a user who claims via the CLI in another terminal
// expects the banner to disappear on the next navigation, not on
// the next React-cache eviction.
//
// Banner-fetch failures must never break the dashboard: a
// degraded backend (e.g., 503, network error, malformed JSON)
// returns an empty list and logs a warning. Banners are an
// advisory surface, not a load-bearing one.

export type BannerKind = "claim_email";

export type BannerSeverity = "info" | "warn" | "critical";

export type BannerAction = {
  label: string;
  form: {
    endpoint: string;
    fields: string[];
  };
};

export type Banner = {
  kind: BannerKind;
  severity: BannerSeverity;
  title: string;
  body: string;
  action?: BannerAction;
};

export type BannersResponse = {
  banners?: Banner[];
};

/**
 * Fetch the current banner list for the authenticated user.
 *
 * Returns an empty array on any failure — banner errors must not
 * cascade into a broken dashboard.
 */
export async function fetchBanners(
  engineURL: string,
  bearerToken: string,
): Promise<Banner[]> {
  const url = engineURL.replace(/\/+$/, "") + "/v1/system/banners";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`fetchBanners: network error from ${url}: ${msg}`);
    return [];
  }

  if (!res.ok) {
    console.warn(`fetchBanners: HTTP ${res.status} from ${url}`);
    return [];
  }

  let json: BannersResponse;
  try {
    json = (await res.json()) as BannersResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`fetchBanners: invalid JSON from ${url}: ${msg}`);
    return [];
  }
  return json.banners ?? [];
}
