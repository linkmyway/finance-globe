/**
 * Tiered data refresh.
 *
 * Fast tier: market data — refreshed inline on dashboard reads when
 * stale. Slow tier: curated values (policy rates, city rents) —
 * refreshed only when older than ~20 h or when forced, because each
 * value is verified against an official publication and carries its
 * own source + as-of date in the payload.
 *
 * Provenance rule: the UI never shows a number whose source and as-of
 * date are not in the payload.
 */

export interface SourcedValue<T> {
  data: T;
  source: string;
  asOf: string;
  fetchedAt: number; // epoch ms
  status: "ok" | "stale" | "error";
}

export interface Dashboard {
  fx: SourcedValue<unknown>; // Frankfurter (ECB reference rates, daily)
  mag7: SourcedValue<unknown>; // Finnhub quotes
  rates: SourcedValue<unknown>; // FRED + central-bank curated values
  rents: SourcedValue<unknown>; // published rent indices (slow tier)
  m2: SourcedValue<unknown>; // World Bank WDI, annual (slow tier)
  volatility: SourcedValue<unknown>; // FRED VIX + index quotes
}

const SLOW_TIER_MS = 20 * 60 * 60 * 1000;

export interface Refreshers {
  refreshFast(): Promise<void>;
  refreshSlow(): Promise<void>;
}

export async function getDashboard(
  cache: { read(): Promise<Dashboard> },
  refreshers: Refreshers,
  now: number,
  opts: { forceSlow?: boolean } = {},
): Promise<Dashboard> {
  const dash = await cache.read();
  const slowStale =
    opts.forceSlow || now - dash.rates.fetchedAt > SLOW_TIER_MS;
  // Fast sources refresh on every call when stale; the slow, curated
  // tier only on its own clock (or when forced).
  await refreshers.refreshFast();
  if (slowStale) await refreshers.refreshSlow();
  return cache.read();
}

/**
 * Mobile payload discipline (measured on the production build):
 * size cuts come from compact encodings and resolution tiers only —
 * never from removing globe detail or effects.
 *
 *   country polygons  369 KB → 162 KB   city lights  322 KB → 143 KB
 *   land dots         409 KB → 341 KB   main JS      1.95 MB → 1.50 MB
 *   map texture (mobile) 4096w / 33.5 MB VRAM → 2048w / 8.4 MB VRAM
 */
export const PAYLOAD_LEDGER = {
  polygonsKb: [369, 162],
  lightsKb: [322, 143],
  landDotsKb: [409, 341],
  mainJsMb: [1.95, 1.5],
  textureMobile: ["4096w / 33.5MB", "2048w / 8.4MB"],
} as const;
