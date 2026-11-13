// Actions for 宏观星图 · 3D 地球监控台.
//
// Data channels (all verified 2026-11-09, see DATA-PLAN.md):
//   - ctx.tool.finance_ticker : Mag7 quotes + market cap, USD/JPY, S&P 500
//   - Frankfurter API           : daily FX (USD/CNY, USD/JPY, EUR, GBP) + 45d history
//   - FRED public CSV           : DFF (US policy rate), DGS2/DGS10, VIXCLS,
//                                 M2SL (US M2 monthly levels)
//   - Central-bank money series : BoC Valet (CA M2), PBOC via Eastmoney
//                                 datacenter (CN M2), ECB SDMX BSI (EA M3)
//                                 — annual broad-money growth for the M2
//                                 block, computed from annual averages
//                                 (World Bank WDI retired 2026-11-14: no TW
//                                 data, CA/IN/CH/FR empty for ~3 years)
//   - Yahoo chart API           : Nikkei 225 / Shanghai Composite / Nasdaq indices
//   - web_search + inference    : curated slow values (CN/JP policy rates, city
//                                 rents) from official/published sources, each
//                                 carrying its own source + as-of label
//
// Honesty rules: every block stores source + as_of; a failed source keeps the
// previous value and marks the block "stale" instead of zeroing it.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { and, eq, isNull, like, lt, or } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const blockSchema = z.object({
  source: z.string(),
  asOf: z.string(),
  status: z.enum(["ok", "stale"]),
  fetchedAt: z.number(),
  data: z.any(),
});

const dashboardResponse = z.object({
  generatedAt: z.number(),
  fx: blockSchema.nullable(),
  mag7: blockSchema.nullable(),
  rates: blockSchema.nullable(),
  m2: blockSchema.nullable(),
  rents: blockSchema.nullable(),
  volatility: blockSchema.nullable(),
  cables: blockSchema.nullable(),
  countryCaps: blockSchema.nullable(),
  mag7TotalChange30d: z.number().nullable(),
  // Per-section wall-clock ms of the refresh that produced THIS
  // response; null on plain snapshot reads (getDashboard / export).
  refreshTimings: z.record(z.string(), z.number()).nullable(),
});

type Block = z.infer<typeof blockSchema>;
type Db = ReturnType<Ctx["db"]>;

interface TickerInstrument {
  name: string;
  symbol: string | null;
  price: number | null;
  change_percent: number | null;
  market_cap: number | null;
  as_of: string | null;
  history?: { points: Array<{ date: string | null; close: number | null }> } | null;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function readBlock(db: Db, key: string): Promise<Block | null> {
  const rows = await db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      source: row.source,
      asOf: row.asOf,
      status: row.status === "stale" ? "stale" : "ok",
      fetchedAt: row.fetchedAt,
      data: JSON.parse(row.payload),
    };
  } catch {
    return null;
  }
}

async function writeBlock(db: Db, key: string, block: Block): Promise<void> {
  const values = {
    key,
    payload: JSON.stringify(block.data ?? null),
    source: block.source,
    asOf: block.asOf,
    status: block.status,
    fetchedAt: block.fetchedAt,
  };
  await db
    .insert(schema.snapshots)
    .values(values)
    .onConflictDoUpdate({
      target: schema.snapshots.key,
      set: {
        payload: values.payload,
        source: values.source,
        asOf: values.asOf,
        status: values.status,
        fetchedAt: values.fetchedAt,
      },
    });
}

// ---------------------------------------------------------------------------
// Source fetchers — each returns null on failure, never throws.
// ---------------------------------------------------------------------------

// Fetch discipline (2026-11-12 fix): production evidence showed a full
// refreshData taking ~2.5 min — unbounded fetches (no timeout anywhere)
// queued through serial sections, so one hung source stalled everything
// behind it and the client's spinner never stopped. Every fetch below
// carries a hard timeout, and refreshFast runs its sections in parallel;
// a source that exceeds its budget simply fails over to the block's
// keep-last-value + stale path, exactly like any other failure.
const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  ms: number = FETCH_TIMEOUT_MS,
  init?: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** ctx.tool calls accept no AbortSignal — race them against a clock. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchTicker(
  ctx: Ctx,
  symbol: string,
  withHistory: boolean,
): Promise<TickerInstrument | null> {
  const raw = (await withTimeout(
    ctx.tool.finance_ticker(
      symbol,
      withHistory ? { interval: "1d" } : undefined,
    ),
    12_000,
  )) as { content?: { instrument?: TickerInstrument | null } } | null;
  return raw?.content?.instrument ?? null;
}

// ---------------------------------------------------------------------------
// Monthly bars for the unified monthly trend (user, 2026-11-13: 「就按月点
// 统一」— Mag7 and Cap 7 trend lines both become one point per month over
// the same window, 2024-12-31 → today). Since 2026-11-14 the DRAWN
// trends and headline changes are yearly (see fetchYearlyDecCloses /
// buildYearlySeries below); the monthly series stays as the base for
// the trailing-12-month headline change and for the merged row's
// reconstruction. finance_ticker interval "1mo"
// probed live 2026-11-13 for all eight Mag7 symbols: 60 monthly bars,
// bar dated the 1st of the month with close = that month's last-trading-
// day close (AAPL 2024-12 bar = 250.42 ✓, MSFT = 421.50 ✓); exactly 24
// bars fall in the window for the six core names, SPCX has 6 (listed
// 2026-06). The "1wk" interval crashed inside the tool — never use it.
// ---------------------------------------------------------------------------

interface MonthPoint {
  date: string;
  value: number;
}

/** Mag7 monthly window start (month key, inclusive). */
const MAG7_MONTHLY_FROM = "2024-12";

/** "2024-12" → "2024-12-31" (calendar month-end label for the point
 *  whose value is that month's last-trading-day close). */
function monthEndLabel(ym: string): string {
  const [y = 2024, m = 1] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Build one row's monthly series from monthly bars + the live point:
 * completed months take their bar's month-end close (labelled with the
 * calendar month-end date); the current month is topped by the latest
 * daily close (the live point, at its true date) — on every refresh the
 * current month's point updates in place, and once the month ends its
 * final bar close freezes it. Bars before 2024-12 are dropped so the
 * window matches Cap 7 exactly.
 */
function buildMonthlySeries(
  bars: Array<{ date: string | null; close: number | null }>,
  live: { date: string; close: number } | null,
): MonthPoint[] {
  const byMonth = new Map<string, number>();
  for (const p of bars) {
    if (!p.date || typeof p.close !== "number" || !Number.isFinite(p.close))
      continue;
    const ym = p.date.slice(0, 7);
    if (ym < MAG7_MONTHLY_FROM) continue;
    byMonth.set(ym, p.close);
  }
  const liveMonth = live?.date.slice(0, 7);
  const out: MonthPoint[] = [];
  for (const ym of [...byMonth.keys()].sort()) {
    if (liveMonth && ym >= liveMonth) continue;
    out.push({ date: monthEndLabel(ym), value: byMonth.get(ym)! });
  }
  if (live && live.date.slice(0, 7) >= MAG7_MONTHLY_FROM) {
    out.push({ date: live.date, value: live.close });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

async function fetchTickerMonthly(
  ctx: Ctx,
  symbol: string,
): Promise<Array<{ date: string | null; close: number | null }>> {
  const raw = (await withTimeout(
    ctx.tool.finance_ticker(symbol, { interval: "1mo" }),
    12_000,
  )) as { content?: { instrument?: TickerInstrument | null } } | null;
  return raw?.content?.instrument?.history?.points ?? [];
}

/**
 * Nasdaq fallback for the monthly series (same official API as the
 * quote fallback): two years of daily rows, reduced to month-end
 * closes. Returns [] on any gap, never throws.
 */
async function fetchNasdaqMonthly(symbol: string): Promise<MonthPoint[]> {
  try {
    const res = await fetchWithTimeout(
      `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=stocks&fromdate=2024-12-01&limit=600`,
      8_000,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: {
        tradesTable?: {
          rows?: Array<{ date?: string; close?: string }>;
        };
      };
    } | null;
    const rows = [...(j?.data?.tradesTable?.rows ?? [])].reverse();
    const daily: Array<{ date: string; close: number }> = [];
    for (const r of rows) {
      const [m = "", d = "", y = ""] = (r.date ?? "").split("/");
      const close = parseNasdaqNumber(r.close);
      if (!y || close == null) continue;
      daily.push({
        date: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
        close,
      });
    }
    if (daily.length < 2) return [];
    const byMonth = new Map<string, { date: string; close: number }>();
    for (const p of daily) byMonth.set(p.date.slice(0, 7), p);
    const months = [...byMonth.keys()]
      .sort()
      .filter((ym) => ym >= MAG7_MONTHLY_FROM);
    return months.map((ym, i) => {
      const p = byMonth.get(ym)!;
      // The newest month keeps its true last-trading-day date (it is
      // the live point); completed months get the month-end label.
      return i === months.length - 1
        ? { date: p.date, value: p.close }
        : { date: monthEndLabel(ym), value: p.close };
    });
  } catch {
    return [];
  }
}

/** December closes (year → close) from the Yahoo chart API at
 *  range=10y&interval=1mo — the same chart channel fetchIndexHistory
 *  uses for the Cap 7 benchmarks, at monthly grain. Probed live
 *  2026-11-14: 120 bars per symbol, every December 2016–2025 present
 *  for all seven pre-2026 Mag7 names, and the December 2024 bars
 *  match the already-verified month-end anchors exactly (AAPL
 *  250.42, MSFT 421.50). Returns an empty map on any gap. */
async function fetchYahooDecCloses(
  symbol: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const j = (await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo`,
      12_000,
    )) as {
      chart?: {
        result?: Array<{
          meta?: { exchangeTimezoneName?: string };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = j.chart?.result?.[0];
    if (!result) return out;
    const tz = result.meta?.exchangeTimezoneName ?? "UTC";
    const monthFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    });
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    ts.forEach((t, i) => {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) return;
      const ym = monthFmt.format(new Date(t * 1000)); // "YYYY/MM"
      if (ym.slice(5) !== "12") return;
      const year = Number(ym.slice(0, 4));
      if (year >= 2016 && year <= 2025) out.set(year, c);
    });
  } catch {
    // empty map: caller falls back to the Nasdaq channel
  }
  return out;
}

/** December closes from the Nasdaq official API's long daily history
 *  (fromdate 2015-12-01, limit 9999 — probed 2026-11-14: 2,513 rows
 *  for AAPL), reduced to month-end closes. Fallback for the Yahoo
 *  channel above; same official API as the quote fallback. */
async function fetchNasdaqDecCloses(
  symbol: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const res = await fetchWithTimeout(
      `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=stocks&fromdate=2015-12-01&limit=9999`,
      15_000,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return out;
    const j = (await res.json()) as {
      data?: {
        tradesTable?: {
          rows?: Array<{ date?: string; close?: string }>;
        };
      };
    } | null;
    const rows = [...(j?.data?.tradesTable?.rows ?? [])].reverse();
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      const [m = "", , y = ""] = (r.date ?? "").split("/");
      const close = parseNasdaqNumber(r.close);
      if (!y || close == null) continue;
      byMonth.set(`${y}-${m.padStart(2, "0")}`, close);
    }
    for (const [ym, close] of byMonth) {
      if (ym.slice(5) !== "12") continue;
      const year = Number(ym.slice(0, 4));
      if (year >= 2016 && year <= 2025) out.set(year, close);
    }
  } catch {
    // empty map: the row simply gets fewer yearly points
  }
  return out;
}

/** Year-end (December) closes 2016–2025 for one symbol: Yahoo chart
 *  is the primary channel; when it yields fewer than 6 Decembers the
 *  Nasdaq long history takes over, and the two are merged per year
 *  (Yahoo wins) only when neither alone reaches 6. One source per
 *  symbol in practice — both publish split-adjusted closes. */
async function fetchYearlyDecCloses(
  symbol: string,
): Promise<Map<number, number>> {
  const yahoo = await fetchYahooDecCloses(symbol);
  if (yahoo.size >= 6) return yahoo;
  const nasdaq = await fetchNasdaqDecCloses(symbol);
  if (nasdaq.size >= 6) return nasdaq;
  const merged = new Map(nasdaq);
  for (const [y, c] of yahoo) merged.set(y, c);
  return merged;
}

/** Yearly trend points for a Mag7 row (user, 2026-11-14: yearly
 *  cycle): each December close labelled with its calendar year-end
 *  date, topped by the live point at its true date. A December point
 *  for the live point's own year is replaced by the live point
 *  itself (that month is still in progress). */
function buildYearlySeries(
  decCloses: Map<number, number>,
  live: { date: string; close: number } | null,
): MonthPoint[] {
  const out: MonthPoint[] = [];
  const liveYear = live ? Number(live.date.slice(0, 4)) : null;
  for (const year of [...decCloses.keys()].sort((a, b) => a - b)) {
    if (liveYear != null && year >= liveYear) continue;
    out.push({
      date: monthEndLabel(`${year}-12`),
      value: decCloses.get(year)!,
    });
  }
  if (live) out.push({ date: live.date, value: live.close });
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/** Trailing-12-month change from a monthly close series (user,
 *  2026-11-14: 行首大字改近 12 个月涨幅，由月线收盘算): the latest
 *  point vs the point of the same calendar month one year earlier.
 *  Null when that month is not in the series — never approximated
 *  with a different month. */
function change12mFromMonthly(points: MonthPoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const [ys = "0", m = ""] = last.date.split("-");
  const targetYm = `${Number(ys) - 1}-${m}`;
  const base = points.find((p) => p.date.slice(0, 7) === targetYm);
  if (!base || base.value === 0 || base.date === last.date) return null;
  return Number((((last.value - base.value) / base.value) * 100).toFixed(2));
}

/** Last point of each calendar month (series sorted ascending). Shared
 *  by the Cap 7 trend sampling and the Tesla + SpaceX accumulated
 *  merged points. */
function sampleMonthlyPoints<T extends { date: string }>(series: T[]): T[] {
  const byMonth = new Map<string, T>();
  for (const p of series) byMonth.set(p.date.slice(0, 7), p);
  return [...byMonth.values()];
}

// ---------------------------------------------------------------------------
// Nasdaq official API fallback for Mag7 symbols the primary ticker resolver
// misses. Observed 2026-11-10: finance_ticker returns matched="none" /
// instrument=null for MSFT and NVDA (with and without history, and for
// company-name queries) while the other five resolve exactly — and the old
// refresh silently discarded failed symbols, shrinking the stored block to
// 5 rows. Endpoints verified 2026-11-10: /info (name, last sale, change%),
// /summary (MarketCap), /historical (daily closes for the sparkline).
// Returns the same shape as fetchTicker; null on any gap, never throws.
// ---------------------------------------------------------------------------

function parseNasdaqNumber(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchNasdaqFallback(
  symbol: string,
): Promise<TickerInstrument | null> {
  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json",
    };
    const get = async (
      url: string,
    ): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetchWithTimeout(url, 8_000, { headers });
        if (!res.ok) return null;
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const from = new Date(Date.now() - 70 * 86400_000);
    const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
    const [info, summary, hist] = await Promise.all([
      get(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`),
      get(
        `https://api.nasdaq.com/api/quote/${symbol}/summary?assetclass=stocks`,
      ),
      get(
        `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=stocks&fromdate=${fromStr}&limit=45`,
      ),
    ]);
    const infoData = (info?.data ?? null) as {
      companyName?: string;
      primaryData?: { lastSalePrice?: string; percentageChange?: string };
    } | null;
    const price = parseNasdaqNumber(infoData?.primaryData?.lastSalePrice);
    const changePct = parseNasdaqNumber(
      infoData?.primaryData?.percentageChange,
    );
    const summaryData = (summary?.data ?? null) as {
      summaryData?: { MarketCap?: { value?: string } };
    } | null;
    const marketCap = parseNasdaqNumber(
      summaryData?.summaryData?.MarketCap?.value,
    );
    const histData = (hist?.data ?? null) as {
      tradesTable?: { rows?: Array<{ date?: string; close?: string }> };
    } | null;
    // Historical rows arrive newest-first; the sparkline wants oldest-first.
    const points = [...(histData?.tradesTable?.rows ?? [])]
      .reverse()
      .map((r) => {
        const [m = "", d = "", y = ""] = (r.date ?? "").split("/");
        return {
          date: y ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : null,
          close: parseNasdaqNumber(r.close),
        };
      })
      .filter((p) => p.close != null);
    if (price == null || marketCap == null || points.length < 2) return null;
    return {
      name: (infoData?.companyName ?? symbol).replace(/ Common Stock$/, ""),
      symbol,
      price,
      change_percent: changePct,
      market_cap: marketCap,
      as_of: points[points.length - 1]?.date ?? null,
      history: { points },
    };
  } catch {
    return null;
  }
}

interface FredObs {
  date: string;
  value: number;
}

async function fetchFred(series: string): Promise<FredObs[] | null> {
  try {
    const res = await fetchWithTimeout(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`,
    );
    if (!res.ok) return null;
    const text = await res.text();
    // FRED intermittently serves a bot-wall HTML page; that is a failure,
    // not data.
    if (text.trimStart().startsWith("<")) return null;
    const out: FredObs[] = [];
    for (const line of text.split("\n").slice(1)) {
      const [date, raw] = line.split(",");
      if (!date || raw === undefined) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) out.push({ date: date.trim(), value });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

// ---------------------------------------------------------------------------
// Fast refresh: quotes, FX, FRED, World Bank, Yahoo indices.
// ---------------------------------------------------------------------------

const MAG7_CORE = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"] as const;
// Tesla + SpaceX are merged into ONE display row (user, 2026-11-13:
// 「mag7里面 tesla和spacex合一起吧」). SpaceX listed on Nasdaq in June 2026
// under SPCX, so both legs are live quotes on the same finance_ticker
// channel — probed 2026-11-13: SPCX matched=exact, price 139.94, market
// cap ≈ $1.94T; TSLA price 397.45, cap ≈ $1.50T. No private-valuation
// estimate is involved anywhere in the merge.
const MUSK_LEGS = ["TSLA", "SPCX"] as const;
const MAG7_TICKERS = [...MAG7_CORE, ...MUSK_LEGS] as const;
const MUSK_COMBINED_SYMBOL = "TSLA+SPCX";

interface Mag7Leg {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  marketCap: number | null;
  asOf: string | null;
  spark: number[];
  sparkDates: string[];
  /** Monthly trend points (2024-12 → today, one per month; see
   *  buildMonthlySeries). Stored on rows as parallel arrays. */
  sparkM: number[];
  sparkMDates: string[];
  /** Yearly trend points (2016–2025 December closes + the live
   *  point; see buildYearlySeries) — the DRAWN trend for single
   *  rows since the 2026-11-14 yearly unification. The merged row
   *  keeps its monthly merged points instead and leaves these
   *  empty. Stored on rows as parallel arrays. */
  sparkY: number[];
  sparkYDates: string[];
  /** Headline change % since 2026-11-14: trailing 12 months from
   *  the monthly closes for single rows; the merged row overwrites
   *  it with its since-listing change (client labels it 上市以来
   *  from the row's combined flag). changePct stays the daily
   *  change, rendered as small text. */
  changeYearPct: number | null;
}

/** Zip a leg's parallel monthly arrays back into points. */
function monthlyPointsOf(leg: Mag7Leg): MonthPoint[] {
  return leg.sparkMDates
    .map((date, i) => ({ date, value: leg.sparkM[i] ?? NaN }))
    .filter((p) => Number.isFinite(p.value));
}

function legFromQuote(
  symbol: string,
  q: TickerInstrument,
  monthly: MonthPoint[],
  yearly: MonthPoint[],
): Mag7Leg {
  const points = q.history?.points ?? [];
  return {
    symbol,
    name: q.name,
    price: q.price,
    changePct: q.change_percent,
    marketCap: q.market_cap,
    asOf: q.as_of,
    spark: points
      .map((p) => p.close)
      .filter((c): c is number => typeof c === "number")
      .slice(-30),
    sparkDates: points
      .map((p) => p.date)
      .filter((d): d is string => typeof d === "string")
      .slice(-30),
    sparkM: monthly.map((p) => p.value),
    sparkMDates: monthly.map((p) => p.date),
    sparkY: yearly.map((p) => p.value),
    sparkYDates: yearly.map((p) => p.date),
    changeYearPct: change12mFromMonthly(monthly),
  };
}

/** Rebuild a leg from a stored row / stored combined-row component. */
function legFromStored(r: Record<string, unknown>): Mag7Leg | null {
  if (typeof r.symbol !== "string") return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    symbol: r.symbol,
    name: typeof r.name === "string" ? r.name : r.symbol,
    price: num(r.price),
    changePct: num(r.changePct),
    marketCap: num(r.marketCap),
    asOf: typeof r.asOf === "string" ? r.asOf : null,
    spark: Array.isArray(r.spark)
      ? r.spark.filter((x): x is number => typeof x === "number")
      : [],
    sparkDates: Array.isArray(r.sparkDates)
      ? r.sparkDates.filter((x): x is string => typeof x === "string")
      : [],
    sparkM: Array.isArray(r.sparkM)
      ? r.sparkM.filter((x): x is number => typeof x === "number")
      : [],
    sparkMDates: Array.isArray(r.sparkMDates)
      ? r.sparkMDates.filter((x): x is string => typeof x === "string")
      : [],
    sparkY: Array.isArray(r.sparkY)
      ? r.sparkY.filter((x): x is number => typeof x === "number")
      : [],
    sparkYDates: Array.isArray(r.sparkYDates)
      ? r.sparkYDates.filter((x): x is string => typeof x === "string")
      : [],
    changeYearPct: num(r.changeYearPct),
  };
}

/**
 * Combined market-cap sparkline for the merged row: each leg's daily
 * closes × its implied shares outstanding (current cap ÷ current price,
 * near-constant over a 30-day window), summed on the dates both legs
 * share. Falls back to the Tesla leg's price spark when the inputs for
 * the cap reconstruction are missing.
 */
function combinedCapSpark(
  a: Mag7Leg,
  b: Mag7Leg,
): { spark: number[]; sparkDates: string[] } {
  const sharesA =
    a.price && a.marketCap ? a.marketCap / a.price : null;
  const sharesB =
    b.price && b.marketCap ? b.marketCap / b.price : null;
  if (sharesA == null || sharesB == null)
    return { spark: a.spark, sparkDates: a.sparkDates };
  const closesB = new Map<string, number>();
  b.sparkDates.forEach((d, i) => {
    const v = b.spark[i];
    if (v != null) closesB.set(d, v);
  });
  const spark: number[] = [];
  const dates: string[] = [];
  a.sparkDates.forEach((d, i) => {
    const ca = a.spark[i];
    const cb = closesB.get(d);
    if (ca != null && cb != null) {
      spark.push(ca * sharesA + cb * sharesB);
      dates.push(d);
    }
  });
  if (spark.length < 2) return { spark: a.spark, sparkDates: a.sparkDates };
  return { spark: spark.slice(-30), sparkDates: dates.slice(-30) };
}

/**
 * Monthly combined market-cap points for the merged row (user rule,
 * 2026-11-13: the merged line must NEVER be backfilled with Tesla
 * alone). SpaceX listed in June 2026, so the merged series can only
 * start at 2026-06:
 *   - 2026-06 … 2026-10: reconstructed from the two legs' month-end
 *     closes × their CURRENT implied shares (same reconstruction the
 *     daily combined spark uses, at monthly grain);
 *   - 2026-11 onward: the self-accumulated merged points (history
 *     series "mag7_musk_v1", written daily by refreshMag7Section
 *     whenever both legs are live) sampled monthly — last point of
 *     each month wins, so the current month updates in place and a
 *     finished month freezes at its last recorded value.
 * Accumulated points override the reconstruction wherever both exist.
 */
function combinedMonthlySpark(
  a: Mag7Leg,
  b: Mag7Leg,
  accumulated: MonthPoint[],
): { sparkM: number[]; sparkMDates: string[] } {
  const byMonth = new Map<string, MonthPoint>();
  const sharesA = a.price && a.marketCap ? a.marketCap / a.price : null;
  const sharesB = b.price && b.marketCap ? b.marketCap / b.price : null;
  if (sharesA != null && sharesB != null) {
    const bByMonth = new Map(
      monthlyPointsOf(b).map((p) => [p.date.slice(0, 7), p]),
    );
    for (const pa of monthlyPointsOf(a)) {
      const pb = bByMonth.get(pa.date.slice(0, 7));
      if (pb) {
        byMonth.set(pa.date.slice(0, 7), {
          date: pa.date,
          value: pa.value * sharesA + pb.value * sharesB,
        });
      }
    }
  }
  for (const p of accumulated) byMonth.set(p.date.slice(0, 7), p);
  const pts = [...byMonth.values()].sort((x, y) =>
    x.date < y.date ? -1 : 1,
  );
  return {
    sparkM: pts.map((p) => p.value),
    sparkMDates: pts.map((p) => p.date),
  };
}

/** Market-cap-weighted daily change of the two legs. */
function weightedChangePct(a: Mag7Leg, b: Mag7Leg): number | null {
  const parts: Array<{ chg: number; cap: number }> = [];
  for (const leg of [a, b]) {
    if (leg.changePct != null && leg.marketCap != null && leg.marketCap > 0)
      parts.push({ chg: leg.changePct, cap: leg.marketCap });
  }
  if (!parts.length) return a.changePct ?? b.changePct;
  const wsum = parts.reduce((s, p) => s + p.cap, 0);
  if (!wsum) return a.changePct ?? b.changePct;
  return Number(
    (parts.reduce((s, p) => s + p.chg * p.cap, 0) / wsum).toFixed(4),
  );
}

function buildMuskCombinedRow(
  tsla: Mag7Leg,
  spcx: Mag7Leg,
  accumulatedMonthly: MonthPoint[],
): Record<string, unknown> {
  const marketCap =
    tsla.marketCap == null && spcx.marketCap == null
      ? null
      : (tsla.marketCap ?? 0) + (spcx.marketCap ?? 0);
  const { spark, sparkDates } = combinedCapSpark(tsla, spcx);
  const { sparkM, sparkMDates } = combinedMonthlySpark(
    tsla,
    spcx,
    accumulatedMonthly,
  );
  const asOf =
    [tsla.asOf, spcx.asOf]
      .filter((x): x is string => typeof x === "string")
      .sort()
      .pop() ?? null;
  const component = (leg: Mag7Leg, displayName: string) => ({
    symbol: leg.symbol,
    name: displayName,
    price: leg.price,
    changePct: leg.changePct,
    marketCap: leg.marketCap,
    asOf: leg.asOf,
    spark: leg.spark,
    sparkDates: leg.sparkDates,
    sparkM: leg.sparkM,
    sparkMDates: leg.sparkMDates,
  });
  // Headline change for the merged row (user rule, 2026-11-14): the
  // row is younger than 12 months (SpaceX listed 2026-06), so a
  // trailing-12-month figure does not exist — the headline is the
  // change SINCE THE FIRST MERGED POINT (上市以来), computed from
  // the merged monthly points themselves, never from Tesla alone.
  const firstMerged = sparkM[0];
  const lastMerged = sparkM[sparkM.length - 1];
  const sinceListingPct =
    sparkM.length >= 2 && firstMerged && lastMerged
      ? Number((((lastMerged - firstMerged) / firstMerged) * 100).toFixed(2))
      : null;
  return {
    symbol: MUSK_COMBINED_SYMBOL,
    name: "Tesla + SpaceX",
    combined: true,
    // A merged row has no single share price; the client renders the two
    // legs' own prices from `components` instead.
    price: null,
    changePct: weightedChangePct(tsla, spcx),
    marketCap,
    asOf,
    spark,
    sparkDates,
    sparkM,
    sparkMDates,
    // The merged row's trend stays its monthly merged points; the
    // yearly arrays stay empty so the client keeps drawing sparkM.
    sparkY: [],
    sparkYDates: [],
    changeYearPct: sinceListingPct,
    components: [component(tsla, "Tesla"), component(spcx, "SpaceX")],
  };
}

async function refreshMag7Section(ctx: Ctx, db: Db): Promise<void> {
  const now = Date.now();

  // --- Mag7 ---------------------------------------------------------------
  // A symbol is never silently dropped: primary ticker → Nasdaq fallback →
  // last stored row carried forward (block marked stale). Dropping failed
  // symbols is what shrank this block to 5 rows on 2026-11-10. The same
  // discipline applies per-leg for the merged Tesla + SpaceX row: a leg
  // that fails live is carried from the stored combined row's components
  // (or, on the first post-merge refresh, from the legacy standalone
  // TSLA row).
  const oldMag7 = await readBlock(db, "mag7");
  const oldRows = new Map<string, Record<string, unknown>>();
  const oldMag7Data = (oldMag7?.data ?? null) as {
    rows?: Array<Record<string, unknown>>;
  } | null;
  for (const r of oldMag7Data?.rows ?? []) {
    if (typeof r.symbol === "string") oldRows.set(r.symbol, r);
  }
  const oldLegs = new Map<string, Mag7Leg>();
  const oldCombined = oldRows.get(MUSK_COMBINED_SYMBOL);
  const oldComponents = (oldCombined?.components ?? null) as
    | Array<Record<string, unknown>>
    | null;
  if (Array.isArray(oldComponents)) {
    for (const c of oldComponents) {
      const leg = legFromStored(c);
      if (leg) oldLegs.set(leg.symbol, leg);
    }
  }
  for (const sym of MUSK_LEGS) {
    if (oldLegs.has(sym)) continue;
    const row = oldRows.get(sym);
    if (row) {
      const leg = legFromStored(row);
      if (leg) oldLegs.set(sym, leg);
    }
  }
  const primary = await Promise.all(
    MAG7_TICKERS.map((s) => fetchTicker(ctx, s, true)),
  );
  const primaryMiss = primary.map((q) => !q || q.price == null);
  const [quotes, monthlyBars, yearlyDecs] = await Promise.all([
    Promise.all(
      primary.map((q, i) =>
        primaryMiss[i]
          ? fetchNasdaqFallback(MAG7_TICKERS[i] as string)
          : Promise.resolve(q),
      ),
    ),
    Promise.all(MAG7_TICKERS.map((s) => fetchTickerMonthly(ctx, s))),
    Promise.all(MAG7_TICKERS.map((s) => fetchYearlyDecCloses(s))),
  ]);
  let usedFallback = false;
  let carried = false;
  const freshLegs = new Map<string, Mag7Leg>();
  // Monthly series per symbol: primary 1mo bars topped by the quote's
  // latest daily close; the Nasdaq long-history reconstruction when
  // the primary monthly channel yields too little. A symbol whose
  // monthly series cannot be obtained at all is NOT fresh this round —
  // its stored row is carried forward whole (price included) and the
  // block marked stale, per the honesty rule: never fabricate a point.
  const monthlyBySymbol = new Map<string, MonthPoint[]>();
  const yearlyBySymbol = new Map<string, MonthPoint[]>();
  await Promise.all(
    MAG7_TICKERS.map(async (symbol, i) => {
      const q = quotes[i];
      if (!q || q.price == null) return;
      const dailyPts = (q.history?.points ?? []).filter(
        (p): p is { date: string; close: number } =>
          typeof p.date === "string" && typeof p.close === "number",
      );
      const lastDaily = dailyPts[dailyPts.length - 1];
      const live = lastDaily
        ? { date: lastDaily.date, close: lastDaily.close }
        : { date: (q.as_of ?? "").slice(0, 10), close: q.price };
      let monthly = buildMonthlySeries(
        monthlyBars[i] ?? [],
        live.date ? live : null,
      );
      if (monthly.length < 2) {
        const fb = await fetchNasdaqMonthly(symbol);
        if (fb.length >= 2) {
          monthly = fb;
          usedFallback = true;
        }
      }
      if (monthly.length >= 2) monthlyBySymbol.set(symbol, monthly);
      // Yearly trend points from the December closes fetched above;
      // an empty result just leaves the row on its monthly trend.
      const yearly = buildYearlySeries(
        yearlyDecs[i] ?? new Map<number, number>(),
        live.date ? live : null,
      );
      if (yearly.length >= 2) yearlyBySymbol.set(symbol, yearly);
    }),
  );
  quotes.forEach((q, i) => {
    const symbol = MAG7_TICKERS[i] as string;
    if (!q || q.price == null) return;
    const monthly = monthlyBySymbol.get(symbol);
    if (!monthly) return;
    if (primaryMiss[i]) usedFallback = true;
    freshLegs.set(
      symbol,
      legFromQuote(symbol, q, monthly, yearlyBySymbol.get(symbol) ?? []),
    );
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const symbol of MAG7_CORE) {
    const fresh = freshLegs.get(symbol);
    if (fresh) {
      rows.push({ ...fresh });
      continue;
    }
    const old = oldRows.get(symbol);
    if (old) {
      rows.push(old);
      carried = true;
    }
  }
  const muskLegs: Mag7Leg[] = [];
  for (const sym of MUSK_LEGS) {
    const fresh = freshLegs.get(sym);
    if (fresh) {
      muskLegs.push(fresh);
      continue;
    }
    const old = oldLegs.get(sym);
    if (old) {
      muskLegs.push(old);
      carried = true;
    }
  }
  const tslaLeg = muskLegs.find((l) => l.symbol === "TSLA");
  const spcxLeg = muskLegs.find((l) => l.symbol === "SPCX");
  if (tslaLeg && spcxLeg) {
    // Self-accumulated merged points (series "mag7_musk_v1"): today's
    // combined cap is recorded whenever BOTH legs are live this round
    // (same discipline as mag7_total_v2), then the whole series is
    // sampled monthly for the merged trend line. The series starts
    // 2026-11-13; earlier monthly points are reconstructed from the
    // legs' month-end closes (see combinedMonthlySpark).
    let accumulatedMonthly: MonthPoint[] = [];
    if (
      freshLegs.has("TSLA") &&
      freshLegs.has("SPCX") &&
      tslaLeg.marketCap != null &&
      spcxLeg.marketCap != null
    ) {
      const today = new Date(now).toISOString().slice(0, 10);
      const combinedCap = tslaLeg.marketCap + spcxLeg.marketCap;
      await db
        .insert(schema.historyPoints)
        .values({ series: "mag7_musk_v1", date: today, value: combinedCap })
        .onConflictDoUpdate({
          target: [schema.historyPoints.series, schema.historyPoints.date],
          set: { value: combinedCap },
        });
    }
    const accumRows = await db
      .select()
      .from(schema.historyPoints)
      .where(eq(schema.historyPoints.series, "mag7_musk_v1"));
    accumulatedMonthly = sampleMonthlyPoints(
      accumRows
        .map((r) => ({ date: r.date, value: r.value }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    );
    rows.push(buildMuskCombinedRow(tslaLeg, spcxLeg, accumulatedMonthly));
  } else if (tslaLeg ?? spcxLeg) {
    // One leg has never been obtainable (no live quote, nothing stored):
    // show the surviving leg standalone rather than dropping it; the row
    // merges automatically once both legs exist.
    rows.push({ ...(tslaLeg ?? spcxLeg) });
  }
  if (rows.length) {
    rows.sort(
      (a, b) =>
        Number(b.marketCap ?? 0) - Number(a.marketCap ?? 0),
    );
    const total = rows.reduce((s, r) => s + Number(r.marketCap ?? 0), 0);
    await writeBlock(db, "mag7", {
      source: usedFallback
        ? "Finnhub 行情（经 finance_ticker）· 主源缺失标的由 Nasdaq 官方 API 补齐"
        : "Finnhub 行情（经 finance_ticker）",
      asOf: String(rows[0]?.asOf ?? new Date(now).toISOString()),
      status: carried ? "stale" : "ok",
      fetchedAt: now,
      data: { rows, total },
    });
    // Persist today's total market cap for the 30-day change readout —
    // only when every row is live, so the series never mixes a partial
    // (carried-forward) total with full totals. Series is "mag7_total_v2":
    // the Tesla + SpaceX merge (2026-11-13) changed the total's basis —
    // pre-merge totals excluded SpaceX (≈ $1.94T), so comparing across
    // the break would fabricate a one-off jump as if it were growth.
    // The v2 series starts on the merged basis; the old series is left
    // in place, unused.
    if (!carried) {
      const today = new Date(now).toISOString().slice(0, 10);
      await db
        .insert(schema.historyPoints)
        .values({ series: "mag7_total_v2", date: today, value: total })
        .onConflictDoUpdate({
          target: [schema.historyPoints.series, schema.historyPoints.date],
          set: { value: total },
        });
    }
  } else if (oldMag7) {
    await writeBlock(db, "mag7", { ...oldMag7, status: "stale" });
  }

}

// ---------------------------------------------------------------------------
// Country market-cap ranking (added 2026-11-13, user: 「在主页开一个板块
// 把按公司归属的国家市值排名前5排出来」+ 追加口径「加拿大并入美国算
// 一条，合并后第 5 名由印度递补」+ 再追加「扩到前 7 名，板块定名
// Cap 7」— the block shows the top 7 rows after the merge).
//
// Source: CompaniesMarketCap "All countries" page — market cap aggregated
// by COMPANY DOMICILE (归属口径), not by listing venue: a Chinese company
// listed in New York counts toward China. The page's HTML table carries
// exact dollar values in data-sort attributes (verified live 2026-11-13:
// US $79,348,122,555,963 / 3,655 companies; CN $10.639T; JP $7.640T;
// GB $4.626T; IN $4.189T; CA $4.158T; 52 countries, tracked total
// ≈ $149.37T). Parsing the data-sort attributes avoids the rounded
// display strings ("$79.348 T").
//
// Merge rules (user, mirroring the Mag7 Tesla + SpaceX row): Canada
// folds into the United States as ONE combined row "美国 + 加拿大", and
// Taiwan folds into China as "中国 + 台湾" — market caps and company
// counts summed, both legs of each merge kept as components with their
// own values. The ranking is then re-sorted and the top 7 rows taken
// dynamically (each combined row counts as one), so the countries
// behind the merges fill the freed slots automatically. Nothing about
// the top-7 membership is hard-coded.
// ---------------------------------------------------------------------------

const COUNTRY_CAP_NAMES: Record<string, { code: string; name: string }> = {
  "United States": { code: "US", name: "美国" },
  Canada: { code: "CA", name: "加拿大" },
  China: { code: "CN", name: "中国" },
  Japan: { code: "JP", name: "日本" },
  "United Kingdom": { code: "GB", name: "英国" },
  India: { code: "IN", name: "印度" },
  Taiwan: { code: "TW", name: "中国台湾" },
  Switzerland: { code: "CH", name: "瑞士" },
  France: { code: "FR", name: "法国" },
  "South Korea": { code: "KR", name: "韩国" },
  Germany: { code: "DE", name: "德国" },
  "Saudi Arabia": { code: "SA", name: "沙特阿拉伯" },
  Australia: { code: "AU", name: "澳大利亚" },
  Netherlands: { code: "NL", name: "荷兰" },
  Spain: { code: "ES", name: "西班牙" },
  Sweden: { code: "SE", name: "瑞典" },
  Italy: { code: "IT", name: "意大利" },
  Ireland: { code: "IE", name: "爱尔兰" },
  "Hong Kong": { code: "HK", name: "中国香港" },
  "United Arab Emirates": { code: "AE", name: "阿联酋" },
  Brazil: { code: "BR", name: "巴西" },
  Singapore: { code: "SG", name: "新加坡" },
};

/** code → 中文名 (for coverage-flag evidence strings). */
const COUNTRY_CAP_NAMES_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.values(COUNTRY_CAP_NAMES).map((v) => [v.code, v.name]),
);

interface CountryCapParsed {
  en: string;
  code: string;
  name: string;
  marketCap: number;
  companies: number;
}

// ---------------------------------------------------------------------------
// Cap 7 trend + market-cap decomposition (added 2026-11-13, user: 「这个
// 也可以做 mag7 一样的走势图吗 可以看出国家金融流入还是流出 可能需要
// 详细计算一下」+ 麻衣方法论约束).
//
// Trend: the source publishes NO per-country history series, so the
// history is honest segments in ONE series (history_points,
// "cap:<CODE>", ALL parsed countries so future top-7 entrants and both
// merge legs already have a series):
//   (a) Wayback archive backfill (added 2026-11-13, user-approved
//       plan): 24 monthly snapshots of the SAME all-countries page,
//       2024-12-31 … 2026-11-13, imported once by
//       importCap7ArchiveBackfill from a SHA-256-verified staged file
//       (that action retired in the 2026-11-14 edit; its points stay);
//       every point keeps its TRUE archive date (2025-04-20,
//       2025-06-09, 2026-02-26 are mid-month last-available captures,
//       never shifted to month-end), its tracked company count, and
//       source="wayback-backfill". Backfilled shares use each point's
//       52-row sum (total_sum_t) as denominator — the page headline
//       total runs 0.41–0.68T above the row sum in every snapshot
//       (apparently includes off-table items) and is never mixed in.
//   (a2) ONE early year-end point (added 2026-11-14, user: 「Cap 7
//       去挖 2020–2023 年存档」): the page's earliest Wayback capture
//       is 2023-02-20, so 2020–2022 year-ends do not exist in the
//       archive (2022's nearest capture is 51 days out — not used).
//       The last 2023 capture, 2023-12-19, was imported once by
//       importCap7Early2023 from a SHA-256-verified staged file with
//       source="wayback-backfill-early", its true date kept. Its
//       coverage is far thinner (JP 349 companies vs 944 now), so it
//       is a LEVEL reference for the trend line only: drawn dashed /
//       dim, never a growth base (the trailing-12-month window never
//       reaches it), and no cap:TOTAL point was written for it — its
//       denominator is the page headline total, a different basis
//       from the backfill's per-row sums.
//   (b) Live daily points appended by each successful refresh
//       (source="live"), the same accumulation discipline as the Mag7
//       merged total (mag7_total_v2).
// The DRAWN trend is a YEARLY sampling of that merged series (last
// recorded point of each calendar year + the latest point; user,
// 2026-11-14: both boards unified to a yearly cycle — the monthly
// points stay in the table and feed the growth window's base pick).
// Window change + decomposition use a TRAILING-12-MONTH window
// (user, 2026-11-14): the base is the monthly-sampled point closest
// to (latest − 365 days), the actual day count is reported as-is;
// benchmark index / FX histories are fetched over that window and
// computed point-to-point, never interpolated. (Supersedes the
// 2026-11-13 full-span window; the CN+TW window lands entirely after
// its 2025-07-31 calibration anchor under this rule — see below.)
//
// Decomposition (NEVER labelled 资金流入/流出): over the window
//   Δ市值 − 估值效应 = 净增代理 (residual, "net-increase proxy")
// where 估值效应 = 期初市值 × [(1 + 基准股指本币涨幅) × 汇率因子 − 1]
// and 汇率因子 = 期初/期末「本币兑 1 美元」汇率 (USD legs: 1), i.e. the
// USD market cap the country "should" have if only index prices and FX
// had moved. The residual mixes IPOs, net issuance / buyback retire-
// ment, price moves of stocks outside the benchmark, and cross-border
// net buying — it is NOT official flow data and the UI says so.
// Combined rows weight each leg's expected return by its base cap.
// ---------------------------------------------------------------------------

interface CapBench {
  indexSymbol: string;
  indexName: string;
  /** Frankfurter currency (units per USD); null = USD itself;
   *  "FRED:DEXTAUS" = FRED 台币兑美元 series (Frankfurter/ECB does not
   *  publish TWD — verified 2026-11-13, API answers "not found"). */
  fx: string | null;
}

const CAP_BENCH: Record<string, CapBench> = {
  US: { indexSymbol: "^GSPC", indexName: "标普 500", fx: null },
  CA: { indexSymbol: "^GSPTSE", indexName: "S&P/TSX 综合指数", fx: "CAD" },
  CN: { indexSymbol: "000001.SS", indexName: "上证综指", fx: "CNY" },
  TW: { indexSymbol: "^TWII", indexName: "台湾加权指数", fx: "FRED:DEXTAUS" },
  JP: { indexSymbol: "^N225", indexName: "日经 225", fx: "JPY" },
  GB: { indexSymbol: "^FTSE", indexName: "FTSE 100", fx: "GBP" },
  IN: { indexSymbol: "^NSEI", indexName: "NIFTY 50", fx: "INR" },
  CH: { indexSymbol: "^SSMI", indexName: "瑞士 SMI", fx: "CHF" },
  FR: { indexSymbol: "^FCHI", indexName: "CAC 40", fx: "EUR" },
  KR: { indexSymbol: "^KS11", indexName: "KOSPI", fx: "KRW" },
  DE: { indexSymbol: "^GDAXI", indexName: "DAX", fx: "EUR" },
  AU: { indexSymbol: "^AXJO", indexName: "S&P/ASX 200", fx: "AUD" },
  NL: { indexSymbol: "^AEX", indexName: "AEX 指数", fx: "EUR" },
  ES: { indexSymbol: "^IBEX", indexName: "IBEX 35", fx: "EUR" },
  SE: { indexSymbol: "^OMX", indexName: "OMX 斯德哥尔摩 30", fx: "SEK" },
  HK: { indexSymbol: "^HSI", indexName: "恒生指数", fx: "HKD" },
  BR: { indexSymbol: "^BVSP", indexName: "Ibovespa", fx: "BRL" },
  SG: { indexSymbol: "^STI", indexName: "海峡时报指数", fx: "SGD" },
};

interface CapPoint {
  date: string;
  value: number;
  /** Tracked company count at this point (null for pre-backfill live
   *  points written before the column existed). */
  companies?: number | null;
  /** "wayback-backfill" | "live" | null (legacy rows). */
  source?: string | null;
}

/** Last point on or before `date` (series sorted ascending). */
function capAtOrBefore(series: CapPoint[], date: string): CapPoint | null {
  let found: CapPoint | null = null;
  for (const p of series) {
    if (p.date <= date) found = p;
    else break;
  }
  return found;
}

function capShiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function capDayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000,
  );
}

interface CapWindow {
  base: CapPoint;
  last: CapPoint;
  windowDays: number;
  /** "12m" = trailing 12 months (base = monthly point closest to
   *  latest − 365 days) — the standard window since 2026-11-14;
   *  "full" = longest available window (first → last point of the
   *  merged backfill + live series, span ≥ 30 days), "30d" and
   *  "sinceStart" remain only as fallbacks for a series too young
   *  to hold a 12-month base; "calibrated" = CN+TW fallback: window
   *  starts at the post-expansion anchor 2025-07-31 (see
   *  CN_CALIBRATION_ANCHOR below); "mixed" = top-7 aggregate whose
   *  rows use differing window bases. */
  basis: "12m" | "full" | "30d" | "sinceStart" | "calibrated" | "mixed";
  changePct: number;
}

/** China calibration anchor (user decision 2026-11-13: 「只校准中国」).
 *  CMC's China coverage jumped 2025-06 → 2025-07 from 329 to 474
 *  tracked companies (+44%) while the cap print jumped $7.909T →
 *  $9.807T — a large share of that step is newly-included companies,
 *  not market growth. Comparing the narrow-coverage old values with
 *  the wide-coverage new values as one growth rate presents coverage
 *  expansion as market growth, so the CN+TW row's changePct and
 *  decomposition must start no earlier than the first
 *  post-expansion archive point, 2025-07-31 (CN $9.807T · 474 家,
 *  TW $2.218T · 102 家, combined $12.025T). Since the 2026-11-14
 *  yearly unification the row uses the same trailing-12-month
 *  window as every other row — its base (≈2025-11) sits after the
 *  anchor by construction, and capWindowCalibrated remains only as
 *  a guard. The TW leg shares the row window so the row stays
 *  internally consistent. The full series is still drawn (yearly
 *  points); the pre-anchor segment is only excluded from growth /
 *  decomposition, never hidden, and the client still dashes it. */
const CN_CALIBRATION_ANCHOR = "2025-07-31";
const CN_CALIBRATED_ROW_CODE = "CN+TW";

/** Calibrated window for the CN+TW row: base = first point on or
 *  after the anchor (the 2025-07-31 archive point itself when the
 *  backfill is present), last = latest point. Falls back to null
 *  when no post-anchor base exists. */
function capWindowCalibrated(series: CapPoint[]): CapWindow | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const base = series.find((p) => p.date >= CN_CALIBRATION_ANCHOR) ?? null;
  if (!base || base.date === last.date || base.value === 0) return null;
  const spanDays = capDayDiff(base.date, last.date);
  if (spanDays <= 0) return null;
  return {
    base,
    last,
    windowDays: spanDays,
    basis: "calibrated",
    changePct: Number(
      (((last.value - base.value) / base.value) * 100).toFixed(2),
    ),
  };
}

/** Trailing-12-month window (user, 2026-11-14: both boards' growth
 *  unified to a yearly cycle): base = the point of the MONTHLY
 *  sampling closest to (latest − 365 days); the actual span is
 *  reported as-is (with monthly points it lands within a few weeks
 *  of 365 days). Returns null when the series cannot support a
 *  ~12-month window (span too short, or the picked base sits
 *  implausibly far from the target) — callers then fall back to the
 *  legacy window rules. */
function capWindow12m(series: CapPoint[]): CapWindow | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1]!;
  const target = capShiftDate(last.date, -365);
  let base: CapPoint | null = null;
  let best = Infinity;
  for (const p of sampleMonthlyPoints(series)) {
    if (p.date >= last.date) continue;
    const d = Math.abs(capDayDiff(p.date, target));
    if (d < best) {
      best = d;
      base = p;
    }
  }
  if (!base || base.value === 0) return null;
  const spanDays = capDayDiff(base.date, last.date);
  if (spanDays < 300 || spanDays > 430) return null;
  return {
    base,
    last,
    windowDays: spanDays,
    basis: "12m",
    changePct: Number(
      (((last.value - base.value) / base.value) * 100).toFixed(2),
    ),
  };
}

/** Effective window for a Cap 7 row: trailing 12 months for every
 *  row (2026-11-14 unification). For CN+TW the 12-month base lands
 *  after the 2025-07-31 calibration anchor on its own (base ≈
 *  2025-11 today, and the base only moves forward from here); the
 *  calibrated window remains as a guard should a 12-month base ever
 *  fall before the anchor, and the legacy longest-window rules are
 *  the last resort for a series too young for either. */
function capWindowForRow(rowCode: string, series: CapPoint[]): CapWindow | null {
  const w12 = capWindow12m(series);
  if (rowCode === CN_CALIBRATED_ROW_CODE) {
    if (w12 && w12.base.date >= CN_CALIBRATION_ANCHOR) return w12;
    return capWindowCalibrated(series) ?? w12 ?? capWindowFor(series);
  }
  return w12 ?? capWindowFor(series);
}

/** Yearly sampling for the drawn trend (user, 2026-11-14): the last
 *  recorded point of each calendar year — the series' final point is
 *  its own year's last point by construction, so the latest point is
 *  always included at its true date. */
function sampleYearlyPoints<T extends { date: string }>(series: T[]): T[] {
  const byYear = new Map<string, T>();
  for (const p of series) byYear.set(p.date.slice(0, 4), p);
  return [...byYear.values()];
}

/** Window change for one series: the LONGEST available window wins
 *  (user-approved backfill plan, 2026-11-13) — with the archive
 *  backfill in place the span is ~23 months, so the readout and the
 *  decomposition cover the full span; the 30-day / since-start
 *  fallbacks only remain for a series that has not reached a 30-day
 *  span yet. */
function capWindowFor(series: CapPoint[]): CapWindow | null {
  if (series.length < 2) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  if (first.date === last.date || first.value === 0) return null;
  const spanDays = capDayDiff(first.date, last.date);
  if (spanDays >= 30) {
    return {
      base: first,
      last,
      windowDays: spanDays,
      basis: "full",
      changePct: Number(
        (((last.value - first.value) / first.value) * 100).toFixed(2),
      ),
    };
  }
  const target = capShiftDate(last.date, -30);
  const base30 = capAtOrBefore(series, target);
  const base = base30 ?? first;
  if (base.date === last.date || base.value === 0) return null;
  return {
    base,
    last,
    windowDays: capDayDiff(base.date, last.date),
    basis: base30 ? "30d" : "sinceStart",
    changePct: Number((((last.value - base.value) / base.value) * 100).toFixed(2)),
  };
}

/** Daily closes of a benchmark index (Yahoo chart API, ~2 years —
 *  the decomposition window is the trailing 12 months, so the index
 *  history must reach back to the window base for a true
 *  point-to-point valuation effect). */
async function fetchIndexHistory(
  symbol: string,
): Promise<Array<{ date: string; close: number }>> {
  try {
    const j = (await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`,
      10_000,
    )) as {
      chart?: {
        result?: Array<{
          meta?: { exchangeTimezoneName?: string };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = j.chart?.result?.[0];
    if (!result) return [];
    const tz = result.meta?.exchangeTimezoneName ?? "UTC";
    const dayFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const byDate = new Map<string, number>();
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    ts.forEach((t, i) => {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c)) {
        byDate.set(dayFmt.format(new Date(t * 1000)), c);
      }
    });
    return [...byDate.entries()]
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  }
}

interface CapDecomp {
  windowDays: number;
  basis: "12m" | "full" | "30d" | "sinceStart" | "calibrated" | "mixed";
  baseDate: string;
  lastDate: string;
  deltaUsd: number;
  deltaPct: number;
  valuationUsd: number;
  /** 净增代理 (residual) — see the methodology note above. */
  residualUsd: number;
  residualPct: number;
  benchmarks: string[];
  /** 收录口径变动标记 (data-driven, never hard-coded): true when any
   *  leg market's tracked company count moved by more than 5% across
   *  this window — part of that leg's Δ (and therefore of the
   *  residual) is CMC coverage expansion, not market movement. The
   *  residual is still shown in full; the flag only annotates it. */
  coverageChange: boolean;
  /** Human-readable per-leg evidence, e.g. "中国公司数 321→498 家（+55.1%）". */
  coverageNotes: string[];
}

async function refreshCountryCapsSection(db: Db): Promise<void> {
  const now = Date.now();
  const old = await readBlock(db, "country_caps");
  try {
    const res = await fetchWithTimeout(
      "https://companiesmarketcap.com/all-countries/",
      12_000,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "text/html",
        },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const rowRe =
      /data-sort="([A-Za-z ]+)"><a href="[^"]*">[^<]*<\/a><\/td><td class="td-right" data-sort="(\d+)"><span class="currency-symbol-left">\$<\/span>[^<]*<\/td><td class="td-right" data-sort="(\d+)">/g;
    const parsed: CountryCapParsed[] = [];
    for (const m of html.matchAll(rowRe)) {
      const en = m[1] as string;
      const meta = COUNTRY_CAP_NAMES[en];
      parsed.push({
        en,
        code: meta?.code ?? en,
        name: meta?.name ?? en,
        marketCap: Number(m[2]),
        companies: Number(m[3]),
      });
    }
    // Sanity gate: the merge and the ranking are meaningless without the
    // six countries the current top of the table is built from; a partial
    // parse counts as a failed fetch, never as data.
    const byCode = new Map(parsed.map((p) => [p.code, p]));
    for (const need of ["US", "CA", "CN", "TW", "JP", "GB", "IN"]) {
      if (!byCode.has(need)) throw new Error(`country_caps parse miss ${need}`);
    }
    if (parsed.length < 30) throw new Error("country_caps parse too short");
    const globalTotal = parsed.reduce((s, p) => s + p.marketCap, 0);
    // --- Trend history: append today's caps for EVERY parsed country
    // to history_points (series "cap:<CODE>", source="live", with the
    // tracked company count), plus the row-sum global total point
    // ("cap:TOTAL"). The Wayback points already in the table are
    // never touched here — a live write only ever targets todayStr,
    // and on the one overlapping date (2026-11-13) the live value
    // winning over the archive point is the approved rule. Pruning
    // (below) never touches Wayback points of either vintage.
    const todayStr = new Date(now).toISOString().slice(0, 10);
    for (const p of parsed) {
      await db
        .insert(schema.historyPoints)
        .values({
          series: `cap:${p.code}`,
          date: todayStr,
          value: p.marketCap,
          companies: p.companies,
          source: "live",
        })
        .onConflictDoUpdate({
          target: [schema.historyPoints.series, schema.historyPoints.date],
          set: {
            value: p.marketCap,
            companies: p.companies,
            source: "live",
          },
        });
    }
    await db
      .insert(schema.historyPoints)
      .values({
        series: "cap:TOTAL",
        date: todayStr,
        value: globalTotal,
        companies: null,
        source: "live",
      })
      .onConflictDoUpdate({
        target: [schema.historyPoints.series, schema.historyPoints.date],
        set: { value: globalTotal, source: "live" },
      });
    // Prune: only self-accumulated points (live, or legacy rows with
    // no source tag) older than ~800 days. Wayback points — the
    // monthly backfill AND the 2023 early point — are never pruned:
    // the yearly trend line takes each year's last point from them,
    // so pruning one would silently shorten the drawn history.
    await db
      .delete(schema.historyPoints)
      .where(
        and(
          like(schema.historyPoints.series, "cap:%"),
          lt(schema.historyPoints.date, capShiftDate(todayStr, -800)),
          or(
            eq(schema.historyPoints.source, "live"),
            isNull(schema.historyPoints.source),
          ),
        ),
      );
    const histRows = await db
      .select()
      .from(schema.historyPoints)
      .where(like(schema.historyPoints.series, "cap:%"));
    const capSeries = new Map<string, CapPoint[]>();
    const allDates = new Set<string>();
    const backfillDates = new Set<string>();
    const liveDates = new Set<string>();
    for (const r of histRows) {
      const code = r.series.slice(4);
      const arr = capSeries.get(code) ?? [];
      arr.push({
        date: r.date,
        value: r.value,
        companies: r.companies ?? null,
        source: r.source ?? null,
      });
      capSeries.set(code, arr);
      if (code !== "TOTAL") {
        allDates.add(r.date);
        if (r.source === "wayback-backfill") backfillDates.add(r.date);
        if (r.source === "live") liveDates.add(r.date);
      }
    }
    for (const arr of capSeries.values()) {
      arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    const historyDays = allDates.size;
    const backfillSorted = [...backfillDates].sort();
    const liveSorted = [...liveDates].sort();
    const historyMeta = {
      historyPoints: historyDays,
      backfillPoints: backfillSorted.length,
      backfillFrom: backfillSorted[0] ?? null,
      backfillTo: backfillSorted[backfillSorted.length - 1] ?? null,
      liveSince: liveSorted[0] ?? null,
    };
    /** A row's own series: one leg as-is; a combined row sums its legs
     *  on the dates BOTH legs were recorded (same fetch days, so the
     *  intersection is the full fetch calendar in practice). The
     *  combined point inherits the early-archive flag when either
     *  leg's point is the 2023 early point, so the yearly trend can
     *  dash that segment on combined rows too. */
    const rowSeriesOf = (legs: string[]): CapPoint[] => {
      if (legs.length === 1) return capSeries.get(legs[0]!) ?? [];
      const [a, b] = legs as [string, string];
      const bMap = new Map(
        (capSeries.get(b) ?? []).map((p) => [p.date, p]),
      );
      const out: CapPoint[] = [];
      for (const p of capSeries.get(a) ?? []) {
        const bp = bMap.get(p.date);
        if (bp != null) {
          out.push({
            date: p.date,
            value: p.value + bp.value,
            source:
              p.source === "wayback-backfill-early" ||
              bp.source === "wayback-backfill-early"
                ? "wayback-backfill-early"
                : (p.source ?? bp.source ?? null),
          });
        }
      }
      return out;
    };
    const share = (cap: number) =>
      Number(((cap / globalTotal) * 100).toFixed(2));
    // Two user-ordered merges, same treatment as the Mag7 Tesla + SpaceX
    // row: 加拿大并入美国 (2026-11-13 追加), 台湾并入中国 (同日再追加).
    const combinedOf = (
      code: string,
      name: string,
      a: CountryCapParsed,
      b: CountryCapParsed,
    ) => ({
      code,
      name,
      combined: true,
      marketCap: a.marketCap + b.marketCap,
      companies: a.companies + b.companies,
      sharePct: share(a.marketCap + b.marketCap),
      components: [
        {
          code: a.code,
          name: a.name,
          marketCap: a.marketCap,
          companies: a.companies,
        },
        {
          code: b.code,
          name: b.name,
          marketCap: b.marketCap,
          companies: b.companies,
        },
      ],
    });
    const mergedCodes = new Set(["US", "CA", "CN", "TW"]);
    const combinedRows = [
      combinedOf("US+CA", "美国 + 加拿大", byCode.get("US")!, byCode.get("CA")!),
      combinedOf("CN+TW", "中国 + 台湾", byCode.get("CN")!, byCode.get("TW")!),
    ];
    const rest = parsed
      .filter((p) => !mergedCodes.has(p.code))
      .map((p) => ({
        code: p.code,
        name: p.name,
        combined: false,
        marketCap: p.marketCap,
        companies: p.companies,
        sharePct: share(p.marketCap),
        components: null,
      }));
    const rankedBase = [...combinedRows, ...rest]
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, 7)
      .map((r, i) => ({ rank: i + 1, ...r }));
    const topTotal = rankedBase.reduce((s, r) => s + r.marketCap, 0);

    // --- Decomposition inputs: benchmark index + FX history for the
    // legs of the CURRENT top 7 only (≤9 countries). Any failure here
    // degrades the affected rows' decomposition to null — the ranking,
    // sparklines and window changes above never depend on it.
    const legsOf = (r: (typeof rankedBase)[number]): string[] =>
      r.combined && r.components
        ? r.components.map((c) => c.code)
        : [r.code];
    const neededLegs = [
      ...new Set(rankedBase.flatMap((r) => legsOf(r))),
    ].filter((code) => CAP_BENCH[code]);
    const anyWindow = rankedBase.some(
      (r) => capWindowForRow(r.code, rowSeriesOf(legsOf(r))) != null,
    );
    const indexHist = new Map<string, Array<{ date: string; close: number }>>();
    const fxHist = new Map<string, CapPoint[]>();
    if (anyWindow && neededLegs.length) {
      await Promise.all(
        neededLegs.map(async (code) => {
          const bench = CAP_BENCH[code]!;
          indexHist.set(code, await fetchIndexHistory(bench.indexSymbol));
        }),
      );
      const frankCcys = [
        ...new Set(
          neededLegs
            .map((c) => CAP_BENCH[c]!.fx)
            .filter(
              (f): f is string =>
                typeof f === "string" && !f.startsWith("FRED:"),
            ),
        ),
      ];
      if (frankCcys.length) {
        try {
          // FX history must cover the whole decomposition window:
          // start a fortnight before the earliest window base in play
          // (trailing-12-month bases sit about a year back), so both
          // window ends resolve to real rates.
          let earliestBase = todayStr;
          for (const r of rankedBase) {
            const w = capWindowForRow(r.code, rowSeriesOf(legsOf(r)));
            if (w && w.base.date < earliestBase) earliestBase = w.base.date;
          }
          const start = capShiftDate(earliestBase, -14);
          const range = (await fetchJson(
            `https://api.frankfurter.dev/v1/${start}..${todayStr}?base=USD&symbols=${frankCcys.join(",")}`,
          )) as { rates?: Record<string, Record<string, number>> };
          for (const [date, dayRates] of Object.entries(range.rates ?? {})) {
            for (const [ccy, v] of Object.entries(dayRates)) {
              if (typeof v !== "number") continue;
              const arr = fxHist.get(ccy) ?? [];
              arr.push({ date, value: v });
              fxHist.set(ccy, arr);
            }
          }
          for (const arr of fxHist.values()) {
            arr.sort((a, b) => (a.date < b.date ? -1 : 1));
          }
        } catch {
          // FX history unavailable this round: non-USD legs lose their
          // decomposition (null), nothing else is affected.
        }
      }
      if (neededLegs.some((c) => CAP_BENCH[c]!.fx === "FRED:DEXTAUS")) {
        const twd = await fetchFred("DEXTAUS");
        if (twd) {
          fxHist.set(
            "FRED:DEXTAUS",
            twd.map((o) => ({ date: o.date, value: o.value })),
          );
        }
      }
    }
    /** One leg's valuation effect over the row window; null when any
     *  input (index or FX at both ends) is missing. Also reports the
     *  leg's company-count move across the window for the coverage
     *  flag (null when either endpoint's count is unknown — legacy
     *  live points — in which case the leg simply cannot flag). */
    const legDecomp = (
      code: string,
      win: CapWindow,
    ): {
      baseCap: number;
      valuationUsd: number;
      deltaUsd: number;
      companiesBase: number | null;
      companiesLast: number | null;
      companiesPct: number | null;
    } | null => {
      const bench = CAP_BENCH[code];
      if (!bench) return null;
      const legSeries = capSeries.get(code) ?? [];
      const legBase = capAtOrBefore(legSeries, win.base.date);
      const legLast = capAtOrBefore(legSeries, win.last.date);
      if (!legBase || !legLast) return null;
      const idx = indexHist.get(code) ?? [];
      const idxBase = capAtOrBefore(
        idx.map((p) => ({ date: p.date, value: p.close })),
        win.base.date,
      );
      const idxLast = capAtOrBefore(
        idx.map((p) => ({ date: p.date, value: p.close })),
        win.last.date,
      );
      if (!idxBase || !idxLast || idxBase.value === 0) return null;
      if (idxLast.date <= idxBase.date) return null;
      let fxFactor = 1;
      if (bench.fx != null) {
        const fxSeries = fxHist.get(bench.fx) ?? [];
        const fxBase = capAtOrBefore(fxSeries, win.base.date);
        const fxLast = capAtOrBefore(fxSeries, win.last.date);
        if (!fxBase || !fxLast || fxLast.value === 0) return null;
        // Rates are units of local currency per USD: a local asset's
        // USD value scales with fxBase/fxLast.
        fxFactor = fxBase.value / fxLast.value;
      }
      const expected = (idxLast.value / idxBase.value) * fxFactor - 1;
      const companiesBase = legBase.companies ?? null;
      const companiesLast = legLast.companies ?? null;
      const companiesPct =
        companiesBase != null &&
        companiesLast != null &&
        companiesBase > 0
          ? Number(
              (
                ((companiesLast - companiesBase) / companiesBase) *
                100
              ).toFixed(1),
            )
          : null;
      return {
        baseCap: legBase.value,
        valuationUsd: legBase.value * expected,
        deltaUsd: legLast.value - legBase.value,
        companiesBase,
        companiesLast,
        companiesPct,
      };
    };

    // Per-row windows collected for the top aggregate: each row
    // contributes its OWN window's Δ (since 2026-11-14 every row is
    // on a trailing-12-month window; CN+TW's base sits after the
    // calibration anchor), never a single common-date Δ that would
    // smuggle the CN coverage jump into the total.
    const rowWindows: Array<{
      baseValue: number;
      lastValue: number;
      deltaUsd: number;
      baseDate: string;
      lastDate: string;
      windowDays: number;
      basis: CapWindow["basis"];
    }> = [];
    const ranked = rankedBase.map((r) => {
      const legs = legsOf(r);
      const series = rowSeriesOf(legs);
      const win = capWindowForRow(r.code, series);
      if (win) {
        rowWindows.push({
          baseValue: win.base.value,
          lastValue: win.last.value,
          deltaUsd: win.last.value - win.base.value,
          baseDate: win.base.date,
          lastDate: win.last.date,
          windowDays: win.windowDays,
          basis: win.basis,
        });
      }
      let decomp: CapDecomp | null = null;
      if (win) {
        const parts = legs.map((code) => legDecomp(code, win));
        if (parts.every((p) => p != null)) {
          const baseCap = win.base.value;
          const valuationUsd = parts.reduce((s, p) => s + p!.valuationUsd, 0);
          const deltaUsd = win.last.value - win.base.value;
          const residualUsd = deltaUsd - valuationUsd;
          // Coverage flag, purely data-driven: any leg whose tracked
          // company count moved >5% across THIS window flags the row.
          const coverageNotes: string[] = [];
          parts.forEach((p, i) => {
            if (
              p!.companiesPct != null &&
              Math.abs(p!.companiesPct) > 5 &&
              p!.companiesBase != null &&
              p!.companiesLast != null
            ) {
              const legName =
                COUNTRY_CAP_NAMES_BY_CODE[legs[i]!] ?? legs[i]!;
              const sign = p!.companiesPct > 0 ? "+" : "";
              coverageNotes.push(
                `${legName}公司数 ${p!.companiesBase}→${p!.companiesLast} 家（${sign}${p!.companiesPct}%）`,
              );
            }
          });
          decomp = {
            windowDays: win.windowDays,
            basis: win.basis,
            baseDate: win.base.date,
            lastDate: win.last.date,
            deltaUsd,
            deltaPct: win.changePct,
            valuationUsd,
            residualUsd,
            residualPct: Number(((residualUsd / baseCap) * 100).toFixed(2)),
            benchmarks: legs
              .map((c) => CAP_BENCH[c]?.indexName)
              .filter((x): x is string => typeof x === "string"),
            coverageChange: coverageNotes.length > 0,
            coverageNotes,
          };
        }
      }
      // Trend line: YEARLY sampling of the full merged series (user,
      // 2026-11-14: both boards unified to a yearly cycle) — the last
      // recorded point of each calendar year plus the latest point:
      // today that is 2023-12-19 (the early archive point), then
      // 2024-12-31, 2025-12-30 and the latest live point. The monthly
      // points stay in the table untouched — the trailing-12-month
      // window above picks its base from them. sparkEarly flags the
      // thin-coverage 2023 point so the client draws its segment
      // dashed / dim; calibrationAnchor still marks the CN+TW
      // pre-anchor segment the same way (the two coincide there).
      const sparkSeries = sampleYearlyPoints(series);
      return {
        ...r,
        spark: sparkSeries.map((p) => p.value),
        sparkDates: sparkSeries.map((p) => p.date),
        sparkEarly: sparkSeries.map(
          (p) => p.source === "wayback-backfill-early",
        ),
        changePct: win?.changePct ?? null,
        windowDays: win?.windowDays ?? 0,
        changeBasis: win?.basis ?? null,
        calibrationAnchor:
          r.code === CN_CALIBRATED_ROW_CODE ? CN_CALIBRATION_ANCHOR : null,
        decomp,
      };
    });

    // 前七合计（各行窗口汇总）：合计不用共同日期序列算单一窗口，
    // 而是按各行自身窗口汇总行级 Δ市值 / 估值效应 / 净增代理。
    // 2026-11-14 统一近 12 个月后，各行窗口同为约一年（基点同为
    // 月度序列里最接近「最新点往前 12 个月」的点，实践中同日），
    // 中国行的窗口整个落在 2025-07-31 校准锚点之后，合计因此仍不
    // 包含 CN 的收录口径跳变增量。合计涨跌的分母 = 各行窗口期初
    // 市值之和；合计窗口天数 / 起止 = 各行窗口的最早起点 → 最晚
    // 终点；basis = 各行共同 basis（全为 "12m" 时即 "12m"），行间
    // 不一致时为 "mixed"。分解仅当七行全部可分解时给出，避免拿
    // 部分残差充合计；涨跌汇总只依赖行窗口，与分解是否可得无关。
    const rowBases = [...new Set(rowWindows.map((w) => w.basis))];
    const commonRowBasis: CapWindow["basis"] | null =
      rowBases.length === 1 ? rowBases[0]! : rowBases.length > 1 ? "mixed" : null;
    const topAgg =
      rowWindows.length === ranked.length && rowWindows.length > 0
        ? {
            baseSum: rowWindows.reduce((s, w) => s + w.baseValue, 0),
            deltaUsd: rowWindows.reduce((s, w) => s + w.deltaUsd, 0),
            baseDate: rowWindows.reduce(
              (min, w) => (w.baseDate < min ? w.baseDate : min),
              rowWindows[0]!.baseDate,
            ),
            lastDate: rowWindows.reduce(
              (max, w) => (w.lastDate > max ? w.lastDate : max),
              rowWindows[0]!.lastDate,
            ),
          }
        : null;
    const topChangePct =
      topAgg && topAgg.baseSum !== 0
        ? Number(((topAgg.deltaUsd / topAgg.baseSum) * 100).toFixed(2))
        : null;
    const topWindowDays =
      topAgg != null ? capDayDiff(topAgg.baseDate, topAgg.lastDate) : 0;
    const topChangeBasis: CapWindow["basis"] | null =
      topAgg == null ? null : commonRowBasis;
    let topDecomp: CapDecomp | null = null;
    if (
      topAgg &&
      topAgg.baseSum !== 0 &&
      ranked.every((r) => r.decomp != null) &&
      ranked.length > 0
    ) {
      const valuationUsd = ranked.reduce(
        (s, r) => s + (r.decomp?.valuationUsd ?? 0),
        0,
      );
      const deltaUsd = topAgg.deltaUsd;
      const residualUsd = deltaUsd - valuationUsd;
      const topCoverageNotes = [
        ...new Set(ranked.flatMap((r) => r.decomp?.coverageNotes ?? [])),
      ];
      topDecomp = {
        windowDays: topWindowDays,
        basis: topChangeBasis!,
        baseDate: topAgg.baseDate,
        lastDate: topAgg.lastDate,
        deltaUsd,
        deltaPct: topChangePct!,
        valuationUsd,
        residualUsd,
        residualPct: Number(((residualUsd / topAgg.baseSum) * 100).toFixed(2)),
        benchmarks: [],
        coverageChange: topCoverageNotes.length > 0,
        coverageNotes: topCoverageNotes,
      };
    }

    await writeBlock(db, "country_caps", {
      source:
        "CompaniesMarketCap 各国上市公司市值榜（按公司是哪国的加总）；走势每年一个点，2023 年的点来自 Wayback 存档（当年收录的公司少得多，只作参考），近年的点由每月记下的记录在年底取样；行首涨跌与每行下面那句账都按近 12 个月算，那句账用 Yahoo Finance 的大盘指数和 Frankfurter / FRED 的汇率算",
      asOf: new Date(now).toISOString().slice(0, 10),
      status: "ok",
      fetchedAt: now,
      data: {
        rows: ranked,
        topTotal,
        globalTotal,
        countryCount: parsed.length,
        historyDays,
        ...historyMeta,
        topChangePct,
        topWindowDays,
        topChangeBasis,
        // 中国校准锚点（客户端合计窗口标注与脚注据此生成）
        calibrationAnchor: CN_CALIBRATION_ANCHOR,
        topDecomp,
      },
    });
  } catch {
    if (old) await writeBlock(db, "country_caps", { ...old, status: "stale" });
  }
}

async function refreshFxSection(db: Db): Promise<void> {
  const now = Date.now();

  // --- FX (Frankfurter, daily) --------------------------------------------
  const oldFx = await readBlock(db, "fx");
  try {
    const end = new Date(now);
    const start = new Date(now - 45 * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const range = (await fetchJson(
      `https://api.frankfurter.dev/v1/${iso(start)}..${iso(end)}?base=USD&symbols=CNY,JPY,EUR,GBP`,
    )) as { rates?: Record<string, Record<string, number>> };
    const days = Object.keys(range.rates ?? {}).sort();
    const lastDay = days[days.length - 1];
    if (!lastDay) throw new Error("empty frankfurter range");
    const seriesFor = (ccy: string) =>
      days
        .map((d) => range.rates?.[d]?.[ccy])
        .filter((v): v is number => typeof v === "number");
    const pair = (
      code: string,
      ccy: string,
      invert: boolean,
      digits: number,
    ) => {
      const raw = seriesFor(ccy);
      const vals = invert ? raw.map((v) => 1 / v) : raw;
      const last = vals[vals.length - 1];
      const prev = vals[vals.length - 2];
      if (last === undefined) return null;
      return {
        code,
        rate: Number(last.toFixed(digits)),
        changePct:
          prev !== undefined && prev !== 0
            ? Number((((last - prev) / prev) * 100).toFixed(3))
            : null,
        spark: vals.slice(-30).map((v) => Number(v.toFixed(digits))),
      };
    };
    const pairs = [
      pair("USD/CNY", "CNY", false, 4),
      pair("USD/JPY", "JPY", false, 3),
      pair("EUR/USD", "EUR", true, 4),
      pair("GBP/USD", "GBP", true, 4),
    ].filter(Boolean);
    await writeBlock(db, "fx", {
      source: "Frankfurter（ECB 参考汇率，日频）",
      asOf: lastDay,
      status: "ok",
      fetchedAt: now,
      data: { pairs, date: lastDay },
    });
  } catch {
    try {
      // Backup: open.er-api.com latest-only snapshot.
      const latest = (await fetchJson(
        "https://open.er-api.com/v6/latest/USD",
      )) as { rates?: Record<string, number>; time_last_update_utc?: string };
      const r = latest.rates ?? {};
      const mk = (code: string, v: number | undefined, digits: number) =>
        v === undefined
          ? null
          : { code, rate: Number(v.toFixed(digits)), changePct: null, spark: [] };
      const pairs = [
        mk("USD/CNY", r.CNY, 4),
        mk("USD/JPY", r.JPY, 3),
        mk("EUR/USD", r.EUR ? 1 / r.EUR : undefined, 4),
        mk("GBP/USD", r.GBP ? 1 / r.GBP : undefined, 4),
      ].filter(Boolean);
      if (!pairs.length) throw new Error("er-api empty");
      await writeBlock(db, "fx", {
        source: "ExchangeRate-API（备份源，日频）",
        asOf: latest.time_last_update_utc ?? new Date(now).toISOString(),
        status: "stale",
        fetchedAt: now,
        data: { pairs, date: latest.time_last_update_utc ?? "" },
      });
    } catch {
      if (oldFx) await writeBlock(db, "fx", { ...oldFx, status: "stale" });
    }
  }

}

async function refreshRatesVolSection(ctx: Ctx, db: Db): Promise<void> {
  const now = Date.now();

  // --- FRED: US policy rate, UST yields, VIX --------------------------------
  const [dff, dgs2, dgs10, vix] = await Promise.all([
    fetchFred("DFF"),
    fetchFred("DGS2"),
    fetchFred("DGS10"),
    fetchFred("VIXCLS"),
  ]);
  const lastObs = (obs: FredObs[] | null) =>
    obs && obs.length ? obs[obs.length - 1]! : null;

  const oldRates = await readBlock(db, "rates");
  const oldRatesData = (oldRates?.data ?? {}) as Record<string, unknown>;
  const usRates = {
    effRate: lastObs(dff) ?? (oldRatesData.us as Record<string, unknown>)?.effRate ?? null,
    dgs2: lastObs(dgs2) ?? (oldRatesData.us as Record<string, unknown>)?.dgs2 ?? null,
    dgs10: lastObs(dgs10) ?? (oldRatesData.us as Record<string, unknown>)?.dgs10 ?? null,
  };
  const fredOk = Boolean(dff && dgs2 && dgs10);
  await writeBlock(db, "rates", {
    source: "FRED（美联储圣路易斯联储数据库）+ 各国央行官方发布",
    asOf: lastObs(dff)?.date ?? oldRates?.asOf ?? "",
    status: fredOk ? "ok" : "stale",
    fetchedAt: now,
    data: { us: usRates, curated: oldRatesData.curated ?? [] },
  });

  // --- Volatility: VIX + indices --------------------------------------------
  const oldVol = await readBlock(db, "volatility");
  const oldVolData = (oldVol?.data ?? {}) as Record<string, unknown>;
  const spx = await fetchTicker(ctx, "SPX", false);
  const yahooIndex = async (
    yahooSymbol: string,
    name: string,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const j = (await fetchJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`,
        8_000,
      )) as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              exchangeTimezoneName?: string;
              currentTradingPeriod?: {
                regular?: { start?: number; end?: number };
              };
            };
            timestamp?: number[];
            indicators?: {
              quote?: Array<{ close?: Array<number | null> }>;
            };
          }>;
        };
      };
      const result = j.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta?.regularMarketPrice) return null;
      // 开市状态：源数据自带的交易时段（currentTradingPeriod.regular
      // 的起止 epoch 秒）与当下比对，不靠本地时区猜测；时段缺失时
      // open=null，板面不标休市也不冒充开市。
      const reg = meta.currentTradingPeriod?.regular;
      const nowSec = Math.floor(Date.now() / 1000);
      const open =
        typeof reg?.start === "number" && typeof reg?.end === "number"
          ? nowSec >= reg.start && nowSec <= reg.end
          : null;
      // 报价口径（2026-11-12 修）：旧实现拿 range=5d 的
      // chartPreviousClose 当「昨收」——那是整个窗口之前的收盘，
      // 涨跌幅其实是多日累计，且收盘市场冻结在窗口基线上（生产
      // 实测亚太/美股板冻在旧日线、asOf 停在两天前）。现行口径以
      // 日线 bar 为准，每条报价自带交易所时区下的真实数据日期：
      // - 开市中：实时 regularMarketPrice，涨跌对上一根已完成日线
      //   收盘（最后一根 bar 若同属今日即为进行中会话，往前退一根）；
      // - 已收盘：价 = 最后一根日线收盘，日期 = 该交易日，涨跌对
      //   前一交易日收盘——显示的就是最近一个交易日的收盘。
      const tz = meta.exchangeTimezoneName ?? "UTC";
      const dayFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const dayOf = (epochSec: number) =>
        dayFmt.format(new Date(epochSec * 1000));
      const ts = result?.timestamp ?? [];
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      const bars: Array<{ day: string; close: number }> = [];
      ts.forEach((t, i) => {
        const c = closes[i];
        if (typeof c === "number" && Number.isFinite(c)) {
          bars.push({ day: dayOf(t), close: c });
        }
      });
      const lastBar = bars[bars.length - 1];
      if (!lastBar) return null;
      const prevBar = bars[bars.length - 2] ?? null;
      const today = dayOf(nowSec);
      let price: number;
      let asOf: string;
      let prevClose: number | null;
      if (open) {
        price = meta.regularMarketPrice;
        asOf = today;
        prevClose =
          lastBar.day === today ? (prevBar?.close ?? null) : lastBar.close;
      } else {
        price = lastBar.close;
        asOf = lastBar.day;
        prevClose = prevBar?.close ?? null;
      }
      return {
        name,
        price,
        changePct:
          prevClose != null && prevClose !== 0
            ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
            : null,
        open,
        asOf,
      };
    } catch {
      return null;
    }
  };
  const [nikkei, shanghai, nasdaq] = await Promise.all([
    yahooIndex("^N225", "日经 225"),
    yahooIndex("000001.SS", "上证综指"),
    yahooIndex("^IXIC", "纳斯达克综合"),
  ]);
  const vixObs = lastObs(vix);
  const vixPrev =
    vix && vix.length > 30 ? vix[vix.length - 31] : null;
  const indices: Array<Record<string, unknown>> = [];
  if (spx?.price != null) {
    indices.push({
      name: "标普 500",
      price: spx.price,
      changePct: spx.change_percent,
      asOf: spx.as_of,
    });
  }
  for (const idx of [nikkei, shanghai, nasdaq]) if (idx) indices.push(idx);
  const oldIndices = (oldVolData.indices as Array<Record<string, unknown>>) ?? [];
  // --- 交易所指数板（地球上迷你指数板的数据源）-------------------------
  // 11 家主要交易所的旗舰指数，锚点 id 与 Globe 的板锚点同名（多为
  // GFCI 金融中心 id；深圳 szx 是板专用锚点）。纽约双板：标普 500
  // （nyc）+ 纳斯达克 100（ndx，锚点同为纽约，客户端错位排布）。
  // 不那么有名的交易所不挂板（悉尼/多伦多/圣保罗已按用户口径撤下，
  // 2026-11-11）。日经/上证复用上面已抓的结果，不重复请求。逐板
  // 失败 → 沿用该板上次值；从未取到过的板不进表（客户端整板不
  // 出现），绝不编数。
  const BOARD_DEFS: Array<{ id: string; symbol: string; name: string }> = [
    { id: "nyc", symbol: "^GSPC", name: "标普 500" },
    { id: "ndx", symbol: "^NDX", name: "纳斯达克 100" },
    { id: "ldn", symbol: "^FTSE", name: "FTSE 100" },
    { id: "fra", symbol: "^GDAXI", name: "DAX" },
    { id: "par", symbol: "^FCHI", name: "CAC 40" },
    { id: "sha", symbol: "000001.SS", name: "上证综指" },
    { id: "szx", symbol: "399001.SZ", name: "深证成指" },
    { id: "hkg", symbol: "^HSI", name: "恒生指数" },
    { id: "tyo", symbol: "^N225", name: "日经 225" },
    { id: "sel", symbol: "^KS11", name: "KOSPI" },
    { id: "bom", symbol: "^BSESN", name: "SENSEX" },
  ];
  const boardFetched = new Map<string, Record<string, unknown>>();
  if (nikkei) boardFetched.set("tyo", nikkei);
  if (shanghai) boardFetched.set("sha", shanghai);
  await Promise.all(
    BOARD_DEFS.filter((b) => !boardFetched.has(b.id)).map(async (b) => {
      const r = await yahooIndex(b.symbol, b.name);
      if (r) boardFetched.set(b.id, r);
    }),
  );
  const oldBoards = new Map(
    ((oldVolData.boards as Array<Record<string, unknown>>) ?? []).map(
      (b) => [String(b.id), b],
    ),
  );
  const boards: Array<Record<string, unknown>> = [];
  for (const def of BOARD_DEFS) {
    const fresh = boardFetched.get(def.id);
    const src = fresh ?? oldBoards.get(def.id);
    if (!src) continue;
    boards.push({
      id: def.id,
      name: def.name,
      price: src.price ?? null,
      changePct: src.changePct ?? null,
      open: fresh ? (fresh.open ?? null) : (src.open ?? null),
      // 该板数值的真实日期（交易所时区）：新抓的带本次口径日期，
      // 沿用旧值时保留旧值自带的日期（旧快照无此字段则为 null，
      // 客户端不标日期，不拿抓取时间冒充）。
      asOf: fresh ? (fresh.asOf ?? null) : (src.asOf ?? null),
    });
  }
  // 板块 asOf = 指数/板报价里最新的真实数据日期。VIX 是 FRED 日频、
  // 天然滞后 1–2 个交易日，它的日期在 vix.date 里单独标注；旧实现
  // 拿 VIX 日期当整块 asOf，11-12 抓的数顶着 11-10 的日期示人，
  // 正是「数据像冻住了」的一半来源。
  const quoteDates = [...indices, ...boards]
    .map((x) => (typeof x.asOf === "string" ? x.asOf.slice(0, 10) : ""))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  await writeBlock(db, "volatility", {
    source: "FRED VIXCLS + Yahoo Finance 指数行情（日频）",
    asOf:
      quoteDates[quoteDates.length - 1] ?? vixObs?.date ?? oldVol?.asOf ?? "",
    status: vixObs && indices.length >= 3 ? "ok" : "stale",
    fetchedAt: now,
    data: {
      vix: vixObs
        ? {
            value: vixObs.value,
            date: vixObs.date,
            change30d:
              vixPrev != null
                ? Number((vixObs.value - vixPrev.value).toFixed(2))
                : null,
          }
        : (oldVolData.vix ?? null),
      indices: indices.length ? indices : oldIndices,
      boards,
    },
  });

}

// ---------------------------------------------------------------------------
// Broad-money annual growth, nine markets aligned with Cap 7 (2026-11-14,
// step 1 of the user-approved two-step plan). The World Bank WDI series is
// RETIRED: it has no Taiwan data at all and CA/IN/CH/FR are empty for the
// last ~3 years (verified against the live API 2026-11-13, see DATA-PLAN).
// Seven markets are computed here from official monthly series (US/CA/
// CN/FR plus JP/GB/CH, which joined the auto path in the 2026-11-14
// follow-up once their official APIs were verified: BoJ stat-search,
// BoE IADB CSV, SNB data portal); TW/IN stay on the slow curated pass
// (see refreshSlow — CBC has no machine-readable endpoint, and IN's
// backbone there is a deterministic parse of RBI's annual table).
// Annual growth follows the WDI
// method — growth of the ANNUAL AVERAGE balance — wherever the official
// series is a balance series; curated markets carry their published
// caliber, flagged per market in `basis` ("avg" = annual average,
// "eop" = year-end over year-end) and documented in DATA-PLAN.
// ---------------------------------------------------------------------------

interface M2Entry {
  code: string;
  name: string;
  /** 公布口径名，如实标：M2 / M3 / M4 / M3（欧元区） */
  measure: string;
  basis: "avg" | "eop";
  latestYear: number | null;
  latestValue: number | null;
  points: Array<{ year: number; value: number }>;
  source: string;
}

/** Cap 7 order: US, CA, CN, TW, JP, GB, IN, CH, FR. */
const M2_MARKETS: Array<{
  code: string;
  name: string;
  measure: string;
  basis: "avg" | "eop";
  auto: boolean;
  source: string;
}> = [
  { code: "US", name: "美国", measure: "M2", basis: "avg", auto: true, source: "美联储 M2（FRED M2SL 月度存量）" },
  { code: "CA", name: "加拿大", measure: "M2", basis: "avg", auto: true, source: "加拿大银行 Valet · M2 (gross)" },
  { code: "CN", name: "中国", measure: "M2", basis: "avg", auto: true, source: "中国人民银行货币供应量（东方财富数据中心转引央行发布）" },
  { code: "TW", name: "台湾", measure: "M2", basis: "avg", auto: false, source: "中央银行《金融统计月报》（M2 日平均余额）" },
  { code: "JP", name: "日本", measure: "M2", basis: "avg", auto: true, source: "日本银行マネーストック（时系列统计 API · M2 平均残高）" },
  { code: "GB", name: "英国", measure: "M4", basis: "avg", auto: true, source: "英格兰银行统计数据库 · M4（经季调存量）" },
  { code: "IN", name: "印度", measure: "M3", basis: "eop", auto: false, source: "印度储备银行货币库存构成年表（M3 财年末存量）" },
  { code: "CH", name: "瑞士", measure: "M3", basis: "avg", auto: true, source: "瑞士国家银行数据门户 · M3 存量" },
  { code: "FR", name: "法国", measure: "M3（欧元区）", basis: "avg", auto: true, source: "欧洲央行 BSI · 欧元区 M3（法国适用）" },
];

function emptyM2Entry(m: (typeof M2_MARKETS)[number]): M2Entry {
  return {
    code: m.code,
    name: m.name,
    measure: m.measure,
    basis: m.basis,
    latestYear: null,
    latestValue: null,
    points: [],
    source: m.source,
  };
}

/**
 * Annual-average growth from monthly balances (the WDI method): average
 * the 12 monthly values of each year, growth vs the previous complete
 * year. Incomplete years (incl. the current one) never produce a point.
 */
function annualAvgGrowth(
  monthly: Array<{ ym: string; value: number }>,
): Array<{ year: number; value: number }> {
  const byYear = new Map<number, Map<number, number>>();
  for (const p of monthly) {
    const y = Number(p.ym.slice(0, 4));
    const m = Number(p.ym.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) continue;
    if (!Number.isFinite(p.value)) continue;
    let yr = byYear.get(y);
    if (!yr) byYear.set(y, (yr = new Map()));
    yr.set(m, p.value);
  }
  const avg = new Map<number, number>();
  for (const [y, months] of byYear) {
    if (months.size === 12) {
      avg.set(y, [...months.values()].reduce((a, b) => a + b, 0) / 12);
    }
  }
  const out: Array<{ year: number; value: number }> = [];
  for (const y of [...avg.keys()].sort((a, b) => a - b)) {
    const prev = avg.get(y - 1);
    const cur = avg.get(y);
    if (prev != null && cur != null && prev !== 0) {
      out.push({ year: y, value: Number((((cur - prev) / prev) * 100).toFixed(2)) });
    }
  }
  return out.slice(-11);
}

function m2EntryFromPoints(
  m: (typeof M2_MARKETS)[number],
  points: Array<{ year: number; value: number }>,
  source: string,
): M2Entry {
  const latest = points[points.length - 1] ?? null;
  return {
    code: m.code,
    name: m.name,
    measure: m.measure,
    basis: m.basis,
    latestYear: latest?.year ?? null,
    latestValue: latest?.value ?? null,
    points,
    source,
  };
}

async function refreshM2Section(db: Db): Promise<void> {
  const now = Date.now();
  const oldM2 = await readBlock(db, "m2");
  const oldEntries = new Map<string, M2Entry>();
  const oldCountries = ((oldM2?.data ?? {}) as Record<string, unknown>)
    .countries as Array<Record<string, unknown>> | undefined;
  for (const c of oldCountries ?? []) {
    if (typeof c.code === "string" && M2_MARKETS.some((m) => m.code === c.code)) {
      oldEntries.set(c.code, c as unknown as M2Entry);
    }
  }

  const auto = new Map<string, M2Entry>();

  // --- US: FRED M2SL monthly levels -----------------------------------------
  const m2sl = await fetchFred("M2SL");
  if (m2sl) {
    const pts = annualAvgGrowth(
      m2sl.map((o) => ({ ym: o.date.slice(0, 7), value: o.value })),
    );
    if (pts.length) {
      const m = M2_MARKETS[0]!;
      auto.set("US", m2EntryFromPoints(m, pts, m.source));
    }
  }

  // --- CA: Bank of Canada Valet, M2 (gross) monthly levels ------------------
  try {
    const j = (await fetchJson(
      "https://www.bankofcanada.ca/valet/observations/V41552796/json?start_date=2014-01-01",
    )) as {
      observations?: Array<Record<string, { v?: string } | undefined>>;
    };
    const monthly: Array<{ ym: string; value: number }> = [];
    for (const o of j.observations ?? []) {
      const d = (o as { d?: unknown }).d;
      const v = Number(o.V41552796?.v);
      if (typeof d === "string" && Number.isFinite(v)) {
        monthly.push({ ym: d.slice(0, 7), value: v });
      }
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[1]!;
      auto.set("CA", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  // --- CN: PBOC money supply via Eastmoney datacenter (monthly balances) ----
  try {
    const j = (await fetchJson(
      "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CURRENCY_SUPPLY&columns=ALL&pageSize=600&sortColumns=REPORT_DATE&sortTypes=1",
    )) as {
      result?: {
        data?: Array<{ REPORT_DATE?: string; BASIC_CURRENCY?: number }>;
      };
    };
    const monthly: Array<{ ym: string; value: number }> = [];
    for (const r of j.result?.data ?? []) {
      if (r.REPORT_DATE && typeof r.BASIC_CURRENCY === "number") {
        monthly.push({ ym: r.REPORT_DATE.slice(0, 7), value: r.BASIC_CURRENCY });
      }
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[2]!;
      auto.set("CN", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  // --- FR: ECB SDMX BSI, euro-area M3 monthly stocks -------------------------
  try {
    const j = (await fetchJson(
      "https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.M30.X.1.U2.2300.Z01.E?startPeriod=2014-01&format=jsondata",
    )) as {
      structure?: {
        dimensions?: {
          observation?: Array<{ id: string; values: Array<{ id: string }> }>;
        };
      };
      dataSets?: Array<{
        series?: Record<string, { observations?: Record<string, unknown[]> }>;
      }>;
    };
    const dims = j.structure?.dimensions?.observation ?? [];
    const tdim = dims.find((d) => d.id === "TIME_PERIOD");
    const times = tdim?.values.map((v) => v.id) ?? [];
    const series = j.dataSets?.[0]?.series ?? {};
    const firstKey = Object.keys(series)[0];
    const obs = (firstKey ? series[firstKey]?.observations : undefined) ?? {};
    const monthly: Array<{ ym: string; value: number }> = [];
    for (const [idx, val] of Object.entries(obs)) {
      const ym = times[Number(idx)];
      const v = Array.isArray(val) ? Number(val[0]) : NaN;
      if (ym && Number.isFinite(v)) monthly.push({ ym, value: v });
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[8]!;
      auto.set("FR", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  // --- JP: Bank of Japan time-series API, M2 average amounts outstanding ----
  // MD02 / MAM1NAM2M2MO (monthly, 100M yen). Paginated via NEXTPOSITION.
  try {
    const monthly: Array<{ ym: string; value: number }> = [];
    let startPosition: number | null = null;
    for (let page = 0; page < 8; page++) {
      const url =
        "https://www.stat-search.boj.or.jp/api/v1/getDataCode?db=MD02&code=MAM1NAM2M2MO&startDate=201401&lang=en" +
        (startPosition != null ? `&startPosition=${startPosition}` : "");
      const j = (await fetchJson(url, 20_000)) as {
        RESULTSET?: Array<{
          VALUES?: { SURVEY_DATES?: unknown[]; VALUES?: unknown[] };
        }>;
        NEXTPOSITION?: number;
      };
      const rs = j.RESULTSET?.[0];
      const dates = rs?.VALUES?.SURVEY_DATES ?? [];
      const values = rs?.VALUES?.VALUES ?? [];
      for (let i = 0; i < dates.length; i++) {
        const d = String(dates[i] ?? "");
        const v = Number(values[i]);
        if (/^\d{6}$/.test(d) && Number.isFinite(v)) {
          monthly.push({ ym: `${d.slice(0, 4)}-${d.slice(4, 6)}`, value: v });
        }
      }
      if (typeof j.NEXTPOSITION === "number" && j.NEXTPOSITION > 0) {
        startPosition = j.NEXTPOSITION;
      } else {
        break;
      }
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[4]!;
      auto.set("JP", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  // --- GB: Bank of England IADB CSV, M4 SA amounts outstanding (LPMAUYN) ----
  try {
    const res = await fetchWithTimeout(
      "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2014&Dateto=now&SeriesCodes=LPMAUYN&CSVF=TN&UsingCodes=Y&VPD=Y",
      20_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith("<")) throw new Error("non-CSV response");
    const MONTHS: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const monthly: Array<{ ym: string; value: number }> = [];
    for (const line of text.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d{2}) ([A-Z][a-z]{2}) (\d{4}),([\d.]+)$/);
      const mon = m ? MONTHS[m[2]!] : undefined;
      const v = m ? Number(m[4]) : NaN;
      if (m && mon && Number.isFinite(v)) {
        monthly.push({ ym: `${m[3]}-${mon}`, value: v });
      }
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[5]!;
      auto.set("GB", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  // --- CH: SNB data portal cube snbmonagg, M3 levels (D0=B, D1=GM3) ---------
  try {
    const res = await fetchWithTimeout(
      "https://data.snb.ch/api/cube/snbmonagg/data/csv/en",
      20_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith("<")) throw new Error("non-CSV response");
    const monthly: Array<{ ym: string; value: number }> = [];
    for (const line of text.split("\n")) {
      const parts = line
        .split(";")
        .map((p) => p.trim().replace(/^"|"$/g, ""));
      const [ym, d0, d1, raw] = parts;
      if (!ym || !/^\d{4}-\d{2}$/.test(ym)) continue;
      if (d0 !== "B" || d1 !== "GM3") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) monthly.push({ ym, value: v });
    }
    const pts = annualAvgGrowth(monthly);
    if (pts.length) {
      const m = M2_MARKETS[7]!;
      auto.set("CH", m2EntryFromPoints(m, pts, m.source));
    }
  } catch {
    // keep old entry below
  }

  const countries = M2_MARKETS.map(
    (m) => auto.get(m.code) ?? oldEntries.get(m.code) ?? emptyM2Entry(m),
  );
  const anyAuto = auto.size > 0;
  const anyData = countries.some((c) => c.latestValue != null);
  if (!anyData && oldM2) {
    await writeBlock(db, "m2", { ...oldM2, status: "stale" });
    return;
  }
  const years = countries
    .map((c) => c.latestYear)
    .filter((y): y is number => y != null);
  await writeBlock(db, "m2", {
    source:
      "各国央行官方序列：美/加/中/日/英/瑞/欧元区由月度存量自动算年度增速，台/印为央行发布值核查录入（逐行标注）",
    asOf: years.length
      ? `最新完整年 ${Math.max(...years)} 年`
      : (oldM2?.asOf ?? ""),
    status: anyAuto ? "ok" : "stale",
    fetchedAt: now,
    data: { countries },
  });
}

// ---------------------------------------------------------------------------
// Fast refresh orchestrator: the five sections write disjoint snapshot
// blocks and share no inputs, so they run CONCURRENTLY (2026-11-12 fix —
// they used to queue serially, and with unbounded fetches the tail
// section landed ~2 minutes after the first). The slow cables/IODA
// section in particular must never block the fast market blocks from
// landing. Per-section wall times are returned so a refresh can be
// audited source-by-source; a section that throws (each is written to
// self-handle, this is a backstop) never takes the others down.
// ---------------------------------------------------------------------------

async function refreshFast(
  ctx: Ctx,
): Promise<Record<string, number>> {
  const db = ctx.db<typeof schema>();
  const timings: Record<string, number> = {};
  const timed = async (
    key: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      await fn();
    } catch {
      // Sections keep-last-value on failure by construction; a throw
      // here must not fail the whole refresh.
    }
    timings[key] = Date.now() - t0;
  };
  await Promise.all([
    timed("mag7", () => refreshMag7Section(ctx, db)),
    timed("countryCaps", () => refreshCountryCapsSection(db)),
    timed("fx", () => refreshFxSection(db)),
    timed("ratesVolatility", () => refreshRatesVolSection(ctx, db)),
    timed("m2", () => refreshM2Section(db)),
    timed("cables", () => refreshCables(ctx)),
  ]);
  return timings;
}

// ---------------------------------------------------------------------------
// Submarine-cable status layer (slow variable, refreshed with refreshData).
//
// Honesty boundary: there is NO public per-cable real-time telemetry —
// operators do not publish it. This layer is an aggregation of public
// anomaly signals only:
//   - incidents: hand-curated, publicly reported faults, each with a
//     source link (verified 2026-11-10, see DATA-PLAN.md). "No incident
//     listed" means no public fault report was found, NOT a health proof.
//   - signals: country-level outage events from IODA (Georgia Tech
//     Internet Intelligence Lab) over the last 48 h for the main landing
//     countries. Null when IODA is unreachable — rendered as such.
// ---------------------------------------------------------------------------

// 故障台账（2026-11-10 补强轮：逐条联网查证后补齐 2022 年至今的重大
// 公开记录；每条缆的第一条 = 该缆最新/最重的一条，客户端以它定状态
// 档）。全球年均约 150–200 起故障（ICPC），绝大多数是渔具/船锚小
// 故障、不会逐条公开报道——本表只收有公开来源的重大故障，无记录
// ≠ 从未故障。其余 18 条缆本轮未查到重大公开记录，保持无记录。
const CABLE_INCIDENTS = [
  {
    cableId: "aae1",
    cable: "AAE-1",
    date: "2026-08-25",
    detail:
      "越南方向完全中断；报道称修复待 2026 年 9 月底视维修船与海况启动，另有报道指其 S1.H2 段自 2026 年 2 月起已有问题；截至 2026-09 的报道未见修复完成消息",
    landings: "越南 · 香港",
    status: "已报告故障 · 修复未见公开完成报道",
    sourceName: "越南运营商通报（VOV/VnExpress 经 Substack 汇编）",
    sourceUrl:
      "https://charlesmok.substack.com/p/vietnams-undersea-cable-resilience",
  },
  {
    cableId: "aae1",
    cable: "AAE-1",
    date: "2024-02-24",
    detail:
      "红海段被沉船 Rubymar 的拖锚切断（与 EIG、Seacom 同日受损），亚欧间约 25% 流量受影响；因也门许可延宕，2024 年 7 月下旬才恢复，断约五个月",
    landings: "埃及 · 沙特（红海）",
    status: "已修复（2024-07 恢复）",
    sourceName: "DSI 行业简报（引 Bloomberg/Kentik 记录）",
    sourceUrl:
      "https://digitalsecurityinsights.com/briefings/who-fixes-internet-repair-crisis",
  },
  {
    cableId: "aae1",
    cable: "AAE-1",
    date: "2024-06-15",
    detail:
      "与 APG、IA 于 2024 年 6 月中旬同期故障（越南五缆中三条受损）；其 S1H5 支线修复拖到 2024 年 11 月底才完成",
    landings: "越南",
    status: "已修复（2024-11 完成）",
    sourceName: "海缆维修行业论文（越南案例汇编）",
    sourceUrl:
      "https://mail.indesfoundation.in/article/strategies-for-improved-repair-and-maintenance-of-cable-infrastructure",
  },
  {
    cableId: "aae1",
    cable: "AAE-1",
    date: "2023-02",
    detail:
      "2023 年初越南五条国际海缆同期部分或全部受损（本缆为其一），越南国际容量一度损失约 75%，整批修复最长约九个月",
    landings: "越南",
    status: "已修复",
    sourceName: "越南海缆韧性汇编（引越南官方/运营商通报）",
    sourceUrl:
      "https://charlesmok.substack.com/p/vietnams-undersea-cable-resilience",
  },
  {
    cableId: "aae1",
    cable: "AAE-1",
    date: "2022-11",
    detail:
      "S1H 段分流故障（香港附近海域），越南—香港方向容量一度全失；2023 年 5 月 20 日恢复",
    landings: "越南 · 香港",
    status: "已修复",
    sourceName: "VnExpress / 越南信息传媒部通报",
    sourceUrl:
      "https://e.vnexpress.net/news/news/undersea-cable-fault-slows-internet-speed-in-vietnam-4552977.html",
  },
  {
    cableId: "apg",
    cable: "APG",
    date: "2024-06-15",
    detail:
      "与 AAE-1、IA 于 2024 年 6 月中旬同期故障（越南五缆中三条受损），越南国际网速显著受损；2024 年 9 月完成修复",
    landings: "越南",
    status: "已修复（2024-09 完成）",
    sourceName: "海缆维修行业论文（越南案例汇编）",
    sourceUrl:
      "https://mail.indesfoundation.in/article/strategies-for-improved-repair-and-maintenance-of-cable-infrastructure",
  },
  {
    cableId: "apg",
    cable: "APG",
    date: "2023-02",
    detail:
      "2023 年初越南五条国际海缆同期部分或全部受损（本缆为其一），越南国际容量一度损失约 75%，整批修复最长约九个月",
    landings: "越南",
    status: "已修复",
    sourceName: "越南海缆韧性汇编（引越南官方/运营商通报）",
    sourceUrl:
      "https://charlesmok.substack.com/p/vietnams-undersea-cable-resilience",
  },
  {
    cableId: "apg",
    cable: "APG",
    date: "2022-12-26",
    detail:
      "S6 段故障（香港登陆站附近），越南方向国际容量受损；2023 年 3–4 月分段完成修复",
    landings: "香港 · 越南",
    status: "已修复",
    sourceName: "VnExpress（越南运营商通报）",
    sourceUrl:
      "https://e.vnexpress.net/news/news/undersea-cable-fault-slows-internet-speed-in-vietnam-4552977.html",
  },
  {
    cableId: "apg",
    cable: "APG",
    date: "2022-07-26",
    detail: "越南通报 APG 故障，国际流量被分流；修复完成日期未见公开报道",
    landings: "越南",
    status: "已修复（以来源档案为准）",
    sourceName: "TelcoAIO 海缆中断五年档案",
    sourceUrl: "https://www.telcoaio.com/submarine-cable-outages",
  },
  {
    cableId: "aag",
    cable: "AAG",
    date: "2026-08",
    detail:
      "2026 年 8 月底越南四缆同期受损报道中，本缆被列为已中断、修复预计 2026 年 9 月启动；截至该报道未见修复完成消息",
    landings: "越南 · 香港",
    status: "已报告故障 · 修复未见公开完成报道",
    sourceName: "Developing Telecoms（引 Vietnamnet/VnExpress）",
    sourceUrl:
      "https://www.essential-reading.com/telecom-technology/optical-fixed-networks/20751-vietnam-internet-plagued-by-multiple-subsea-cable-outages-again.html",
  },
  {
    cableId: "aag",
    cable: "AAG",
    date: "2023-02",
    detail:
      "2023 年初越南五条国际海缆同期部分或全部受损（本缆为其一），越南国际容量一度损失约 75%，整批修复最长约九个月",
    landings: "越南",
    status: "已修复",
    sourceName: "越南海缆韧性汇编（引越南官方/运营商通报）",
    sourceUrl:
      "https://charlesmok.substack.com/p/vietnams-undersea-cable-resilience",
  },
  {
    cableId: "aag",
    cable: "AAG",
    date: "2021-10",
    detail:
      "S1i 支线故障（越南—香港段），2022 年 3 月 13 日完成修复，历时约五个月",
    landings: "越南 · 香港",
    status: "已修复",
    sourceName: "VnExpress",
    sourceUrl:
      "https://e.vnexpress.net/news/news/vietnam-internet-cable-fixed-after-five-months-4438589.html",
  },
] as const;

/**
 * 监测走廊（信号层）：海缆是物理层资产、没有 AS 号，但每条缆服务
 * 确定的「登陆国↔登陆国」走廊——用走廊国家的 IODA 国家级异常信号
 * 当这条缆的健康探针。走廊出现异常只说明「这条走廊的联通出了状
 * 况、可能与断缆有关、也可能是别的原因」，不等于这条缆断了；与
 * 上面的新闻台账（红档的唯一依据）严格分层、互不替代。
 */
const CABLE_CORRIDORS: Record<string, string[]> = {
  faster: ["JP", "US"],
  jupiter: ["JP", "PH", "US"],
  ncp: ["CN", "KR", "TW", "JP", "US"],
  "sea-us": ["ID", "PH", "GU", "US"],
  hawaiki: ["AU", "NZ", "US"],
  bifrost: ["SG", "ID", "PH", "GU", "US"],
  echo: ["US", "GU", "SG"],
  aag: ["MY", "SG", "VN", "HK", "PH", "GU", "US"],
  apricot: ["JP", "TW", "GU", "PH", "ID", "SG"],
  apg: ["CN", "HK", "TW", "JP", "KR", "VN", "TH", "MY", "SG"],
  sjc: ["JP", "HK", "CN", "BN", "PH", "SG"],
  "eac-c2c": ["JP", "KR", "CN", "TW", "HK", "SG"],
  marea: ["US", "ES"],
  dunant: ["US", "FR"],
  "grace-hopper": ["US", "GB", "ES"],
  equiano: ["PT", "TG", "NG", "NA", "ZA"],
  "2africa": ["GB", "PT", "ES", "FR", "IT", "EG", "DJ", "KE", "ZA", "NG", "SA", "IN", "PK"],
  peace: ["PK", "DJ", "KE", "EG", "CY", "FR"],
  aae1: ["HK", "VN", "TH", "MY", "SG", "IN", "PK", "OM", "EG", "GR", "IT", "FR"],
  monet: ["US", "BR"],
  curie: ["US", "PA", "CL"],
};

interface CorridorSignal {
  countries: string[];
  latestStart: string;
  datasource: string;
}

/** 由同一批 IODA 事件（与板块顶部速览同源同一次抓取）算每条缆的走廊信号 */
function corridorSignalsFor(
  events: IodaSignalEvent[],
): Record<string, CorridorSignal | null> {
  const out: Record<string, CorridorSignal | null> = {};
  for (const [cableId, codes] of Object.entries(CABLE_CORRIDORS)) {
    const hits = events.filter((e) => codes.includes(e.code));
    if (!hits.length) {
      out[cableId] = null;
      continue;
    }
    const names: string[] = [];
    for (const h of hits) {
      if (!names.includes(h.country)) names.push(h.country);
    }
    out[cableId] = {
      countries: names,
      latestStart: hits[0]!.start,
      datasource: hits[0]!.datasource,
    };
  }
  return out;
}

const IODA_WATCH: Record<string, string> = {
  JP: "日本",
  US: "美国",
  CN: "中国",
  SG: "新加坡",
  PH: "菲律宾",
  ID: "印度尼西亚",
  AU: "澳大利亚",
  NZ: "新西兰",
  GB: "英国",
  FR: "法国",
  ES: "西班牙",
  PT: "葡萄牙",
  NG: "尼日利亚",
  ZA: "南非",
  KE: "肯尼亚",
  EG: "埃及",
  BR: "巴西",
  AR: "阿根廷",
  CL: "智利",
  MX: "墨西哥",
  HK: "中国香港",
  TW: "中国台湾",
  KR: "韩国",
  VN: "越南",
  TH: "泰国",
  MY: "马来西亚",
  BN: "文莱",
  GU: "关岛",
  IN: "印度",
  PK: "巴基斯坦",
  OM: "阿曼",
  AE: "阿联酋",
  QA: "卡塔尔",
  SA: "沙特阿拉伯",
  DJ: "吉布提",
  CY: "塞浦路斯",
  GR: "希腊",
  IT: "意大利",
  TG: "多哥",
  NA: "纳米比亚",
  PA: "巴拿马",
};

interface IodaSignalEvent {
  code: string;
  country: string;
  start: string;
  datasource: string;
  ongoing: boolean;
}

async function fetchIodaSignals(): Promise<{
  events: IodaSignalEvent[];
  checkedAt: string;
} | null> {
  try {
    const until = Math.floor(Date.now() / 1000);
    const from = until - 48 * 3600;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    const res = await fetch(
      `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?entityType=country&from=${from}&until=${until}&limit=200`,
      { signal: ctl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: Array<{
        location?: string;
        location_name?: string;
        start?: number;
        duration?: number;
        datasource?: string;
      }>;
    };
    const events: IodaSignalEvent[] = [];
    for (const e of j.data ?? []) {
      const code = (e.location ?? "").replace("country/", "");
      const name = IODA_WATCH[code];
      if (!name || typeof e.start !== "number") continue;
      events.push({
        code,
        country: name,
        start: new Date(e.start * 1000).toISOString(),
        datasource: e.datasource ?? "—",
        ongoing:
          typeof e.duration === "number" &&
          e.start + e.duration >= until - 1800,
      });
    }
    events.sort((a, b) => (a.start < b.start ? 1 : -1));
    // 返回全部命中事件（上限 40 条）：板块顶部速览在存储时取前 8 条
    // 展示，走廊信号用全量算——两者同源、同一次抓取，不重复请求。
    return {
      events: events.slice(0, 40),
      checkedAt: new Date(until * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

async function refreshCables(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = Date.now();
  const signals = await fetchIodaSignals();
  const old = await readBlock(db, "cables");
  const oldData = (old?.data ?? {}) as {
    signals?: { events?: IodaSignalEvent[]; checkedAt?: string } | null;
    corridorSignals?: Record<string, CorridorSignal | null>;
  };
  // 信号层与速览同源：IODA 可达时用本次全量事件重算走廊信号并把速览
  // 存为前 8 条；不可达时速览与走廊信号一并沿用上次结果并标 stale，
  // 不许拿旧信号冒充刚检查过。
  const liveSignals = signals
    ? {
        events: signals.events.slice(0, 8),
        checkedAt: signals.checkedAt,
      }
    : null;
  await writeBlock(db, "cables", {
    source:
      "公开故障记录（运营商/权威媒体，逐条附链接）+ IODA 国家级中断信号（佐治亚理工 Internet Intelligence Lab）",
    asOf: new Date(now).toISOString().slice(0, 10),
    status: signals ? "ok" : "stale",
    fetchedAt: now,
    data: {
      incidents: CABLE_INCIDENTS,
      signals: liveSignals ?? oldData.signals ?? null,
      corridorSignals: signals
        ? corridorSignalsFor(signals.events)
        : (oldData.corridorSignals ?? null),
      signalsStale: !signals && Boolean(old),
    },
  });
}

// ---------------------------------------------------------------------------
// Slow refresh: nine-market policy rates (Cap 7 set), nine-city rents
// (unified CNY / 80㎡ caliber) and the two curated M2 annual series, via
// search + inference against central-bank publications.
// Runs only when the curated snapshot is missing or older than 20 hours
// (or when forced), because these are monthly-published values.
//
// Freshness has its OWN timestamp (snapshot key "slow_curated"), written
// exclusively by refreshSlow after a successful pass. It used to read the
// rates block's fetchedAt — but refreshFast rewrites that field on every
// call, so the slow values always looked fresh and never actually updated
// (production rents froze at 2026-11-09 this way). The fast path must
// never touch this key.
// ---------------------------------------------------------------------------

const SLOW_SNAPSHOT_KEY = "slow_curated";

/**
 * When the slow curated values were last genuinely fetched. Migration
 * baseline: before this key existed, the only slow-owned timestamp in
 * the store is the rents block's fetchedAt (written exclusively by
 * refreshSlow), so a missing meta row falls back to it — the curated
 * data keeps its real age (e.g. 2026-11-09 in production) and the next
 * refreshData naturally re-fetches instead of pretending it just did.
 */
async function slowCuratedFetchedAt(db: Db): Promise<number> {
  const meta = await readBlock(db, SLOW_SNAPSHOT_KEY);
  if (meta) {
    const d = (meta.data ?? {}) as { curatedFetchedAt?: unknown };
    if (typeof d.curatedFetchedAt === "number") return d.curatedFetchedAt;
    return meta.fetchedAt;
  }
  const rents = await readBlock(db, "rents");
  return rents?.fetchedAt ?? 0;
}

async function markSlowCuratedFetched(db: Db, now: number): Promise<void> {
  await writeBlock(db, SLOW_SNAPSHOT_KEY, {
    source: "慢变量抓取时间戳（仅 refreshSlow 写入）",
    asOf: new Date(now).toISOString(),
    status: "ok",
    fetchedAt: now,
    data: { curatedFetchedAt: now },
  });
}

const curatedSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.string(),
      detail: z.string().nullable(),
      asOf: z.string(),
      source: z.string(),
      /** 原始数值（利率为百分数值；租金为原币数值：纽约=美元月租总额，
       *  上海=元/㎡·月，东京=円/㎡·月）；证据里读不出干净数值时为 null。 */
      num: z.number().nullable(),
    }),
  ),
});

/** 政策利率（九地，与 Cap 7 同序）+ 租金（九城，2026-11-14 第二步补齐）策展 key。
 *  2026-11-14 第一步：cn_repo7d 撤下（隔夜逆回购已成主要政策利率，
 *  见 cn_onrr）；rent_los_angeles / rent_beijing / rent_osaka 撤下
 *  （不在最终九城名单内）。 */
const CURATED_KEYS = [
  "ca_policy",
  "cn_onrr",
  "cn_lpr1y",
  "cn_lpr5y",
  "tw_rediscount",
  "jp_policy",
  "gb_bank_rate",
  "in_repo",
  "ch_policy",
  "fr_ecb_df",
  "rent_new_york",
  "rent_toronto",
  "rent_shanghai",
  "rent_taipei",
  "rent_tokyo",
  "rent_london",
  "rent_mumbai",
  "rent_zurich",
  "rent_paris",
] as const;

/** M2 年度序列（策展两市场：台/印）的蒸馏结构。日/英/瑞已改走央行
 *  官方 API 自动通道（refreshM2Section），不再经策展。 */
const m2SeriesSchema = z.object({
  series: z.array(
    z.object({
      key: z.string(),
      points: z.array(
        z.object({ year: z.number(), value: z.number() }),
      ),
      source: z.string(),
    }),
  ),
});

async function runSearch(
  ctx: Ctx,
  q: string,
  limit = 4,
): Promise<string> {
  try {
    const r = (await ctx.tool.web_search(q)) as {
      content?: {
        results?: Array<{
          title: string;
          source: string | null;
          snippet: string | null;
          published_at: string | null;
        }>;
      };
    } | null;
    const results = (r?.content?.results ?? []).slice(0, limit);
    return (
      `## 查询：${q}\n` +
      results
        .map(
          (x) =>
            `- [${x.source ?? "?"}] ${x.title}（${x.published_at ?? "日期未知"}）：${x.snippet ?? ""}`,
        )
        .join("\n")
    );
  } catch {
    return `## 查询：${q}\n（无结果）`;
  }
}

async function refreshSlow(ctx: Ctx, force: boolean): Promise<void> {
  const db = ctx.db<typeof schema>();
  const rates = await readBlock(db, "rates");
  const curated = ((rates?.data ?? {}) as Record<string, unknown>)
    .curated as Array<Record<string, unknown>> | undefined;
  // 20 h gate reads ONLY the slow pass's own timestamp — never the
  // rates block's fetchedAt, which the fast refresh rewrites every call.
  const lastSlowAt = await slowCuratedFetchedAt(db);
  const freshEnough = Date.now() - lastSlowAt < 20 * 3600_000;
  if (!force && freshEnough && curated && curated.length) return;

  // --- Part 1: policy rates (9 markets) + rents (3 cities) ------------------
  const itemQueries = [
    "Bank of Canada policy interest rate target for the overnight rate latest decision",
    "中国人民银行 隔夜逆回购操作利率 主要政策利率 固定利率",
    "贷款市场报价利率 LPR 1年期 5年期以上 最新公布 全国银行间同业拆借中心",
    "中央銀行 重貼現率 理監事聯席會議 決議 最新",
    "Taiwan central bank CBC discount rate rediscount rate percent latest",
    "日本銀行 政策金利 無担保コール翌日物 誘導目標 最新",
    "Bank of England Bank Rate latest MPC decision percent",
    "RBI policy repo rate latest monetary policy committee decision percent",
    "Swiss National Bank SNB policy rate latest monetary policy assessment",
    "ECB deposit facility rate latest Governing Council decision percent",
    "Zillow ZORI New York metro two bedroom typical rent latest month",
    "Zillow rent index ZORI New York City metro area typical rent September 2026 dollars",
    "CMHC Rental Market Survey October 2025 Toronto CMA average rent two-bedroom purpose-built apartment",
    "上海 住房租金 元/平方米/月 中指研究院 最新",
    "內政部 租金統計 台北市 整戶（層） 租金中位數 最新公布",
    "東京カンテイ 分譲マンション賃料 東京23区 最新 円/㎡",
    "ONS Price Index of Private Rents London two bedroom average monthly rent latest",
    "Magicbricks Rental Index Mumbai 2BHK average monthly rent rupees quarter",
    "Stadt Zürich Mietpreiserhebung 2024 Medianpreis 25.5 Franken pro m2 Nettomiete ganze Stadt Statistik Stadt Zürich",
    "OLAP observatoire des loyers Paris loyer moyen euros par mètre carré hors charges",
  ];
  const evidence = (
    await Promise.all(itemQueries.map((q) => runSearch(ctx, q)))
  ).join("\n\n");
  if (!evidence.trim()) return;

  let distilled: z.infer<typeof curatedSchema> | null = null;
  try {
    distilled = await ctx.inference.complete(
      `你在为一个宏观监控台整理慢变量数据。下面是联网检索到的证据片段。请只从片段中能明确读到的数字提取以下条目；片段里没有可靠数字的条目直接省略，绝不估算或编造。value 写成简洁的展示字符串（如 "2.50%"、"3.00%"），detail 写一句口径说明（可为 null），asOf 写该数字对应的日期或月份（如 "2026-10-20"、"2026-09"），source 写发布机构或数据平台名，num 写该条目的原始数值（利率写百分数值如 2.5；租金见各条说明；读不出干净数值时写 null）。\n\n需要的 key：\n- ca_policy：加拿大银行隔夜利率目标（target for the overnight rate）\n- cn_onrr：中国人民银行隔夜逆回购操作利率（2026-11-02 起为主要政策利率，固定利率）\n- cn_lpr1y：1 年期 LPR\n- cn_lpr5y：5 年期以上 LPR\n- tw_rediscount：台湾中央银行重贴现率\n- jp_policy：日本银行政策利率（无担保隔夜拆借利率诱导目标）\n- gb_bank_rate：英格兰银行银行利率（Bank Rate）\n- in_repo：印度储备银行政策回购利率（policy repo rate）\n- ch_policy：瑞士国家银行政策利率（SNB policy rate）\n- fr_ecb_df：欧洲央行存款便利利率（deposit facility rate，法国适用）\n- rent_new_york：纽约都会区租金，优先 Zillow ZORI 两房（2-bedroom）典型租金；num = 美元月租数值；detail 必须写明实际口径（例如「ZORI 两房典型租金 · 纽约都会区」或「ZORI 全户型典型租金 · 纽约都会区（未取到两房分列值）」），不得把全户型写成两房\n- rent_shanghai：上海市平均租金，优先中指研究院（中国指数研究院）元/㎡·月；num = 每平方米月租数值\n- rent_tokyo：东京 23 区租金，优先東京カンテイ分譲マンション賃料 円/㎡；num = 每平方米月租数值（日元）\n- rent_toronto：多伦多都会区（Toronto CMA）租金，优先 CMHC 租赁市场调查（Rental Market Survey）专门建造出租公寓两房平均租金；num = 加元月租总额数值；detail 写明调查时点\n- rent_taipei：台北市租金，优先内政部租金统计「整户（层）」租金总价中位数；num = 新台币月租总额数值；detail 必须写明该统计不分房数、样本为租金补贴契约，不得写成两房\n- rent_london：伦敦租金，优先 ONS 私人租金价格指数（Price Index of Private Rents）两房平均月租；num = 英镑月租总额数值；detail 写明平均值口径与数据月份\n- rent_mumbai：孟买租金，优先 Magicbricks 租金指数（Rental Index）2BHK 平均月租；num = 印度卢比月租总额数值；detail 必须写明指数口径（如热门搜索地段），不得写成全市官方统计\n- rent_zurich：苏黎世市租金，优先苏黎世市统计局租金调查（Mietpreiserhebung）全市净租金中位数（CHF/㎡·月）；num = 每平方米月租数值（瑞郎）；detail 写明口径（含合作社存量等）\n- rent_paris：巴黎租金，优先巴黎城市圈租金观察站 OLAP 私人租赁平均租金（€/㎡·月，不含杂费）；num = 每平方米月租数值（欧元）\n\n证据：\n${evidence}`,
      { schema: curatedSchema },
    );
  } catch {
    distilled = null;
  }
  const items = (distilled?.items ?? []).filter((i) =>
    (CURATED_KEYS as readonly string[]).includes(i.key),
  );
  // Zurich verified fallback: two forced passes in a row failed to
  // distill the city's figure out of German-language snippets, so the
  // value verified directly from the publisher enters as a curated
  // item whenever (and only when) the distill omits the key. Source:
  // Statistik Stadt Zürich, Mietpreiserhebung 2024 (published
  // 2024-11-05, reference date 2024-03-31) — median net rent for the
  // whole city CHF 25.5/m²·month, incl. cooperative stock. Any later
  // pass whose distill DOES return the key overrides this fallback.
  if (!items.some((i) => i.key === "rent_zurich")) {
    items.push({
      key: "rent_zurich",
      label: "苏黎世市租金",
      value: "25.5 CHF/㎡·月",
      detail:
        "苏黎世市统计局租金调查（Mietpreiserhebung 2024）全市净租金中位数（含合作社存量）",
      asOf: "2024-03",
      source: "苏黎世市统计局（Statistik Stadt Zürich）",
      num: 25.5,
    });
  }

  // --- Part 2: M2 annual series for the two curated markets (TW / IN) -------
  // JP/GB/CH moved to deterministic official-API fetches in
  // refreshM2Section (2026-11-14 follow-up). TW has no machine-readable
  // CBC endpoint (its Financial Statistics Monthly table is a rotating
  // PDF/Excel link), so it stays on search+distill against CBC's own
  // published annual-average growth figures. IN gets a deterministic
  // backbone below (RBI's published annual money-stock table) plus a
  // distill job for the years after that table's edition ends.
  const M2_CURATED_JOBS: Array<{
    key: string;
    name: string;
    caliber: string;
    queries: string[];
  }> = [
    {
      key: "m2_tw",
      name: "台湾",
      caliber: "台湾货币总计数 M2 年增率（全年平均，日平均余额口径）",
      queries: [
        "中央銀行 2025年 M2 平均年增率 4.54% 全年",
        "中央銀行 2024年 全年 M2 平均年增率 新聞稿",
        "中央銀行 2023年 M2 年增率 全年平均 金融統計月報",
        "貨幣總計數 M2 年增率 2022年 全年平均 中央銀行",
        "中央銀行 2019年 M2 平均年增率 新聞稿 全年",
      ],
    },
    {
      key: "m2_in",
      name: "印度",
      caliber: "印度 M3 财年末（3 月末）同比增速",
      queries: [
        "RBI broad money M3 growth 2024-25 per cent annual report",
        "India M3 money stock growth 2023-24 percent Reserve Bank of India",
      ],
    },
  ];
  const m2Found: Array<z.infer<typeof m2SeriesSchema>["series"][number]> = [];
  for (const job of M2_CURATED_JOBS) {
    const ev = (
      await Promise.all(job.queries.map((q) => runSearch(ctx, q, 4)))
    ).join("\n\n");
    if (!ev.trim()) continue;
    try {
      const one = await ctx.inference.complete(
        `你在为一个宏观监控台整理${job.name}的广义货币「年度」增速。下面是联网检索到的证据片段。请只提取片段中明确写出的逐年增速数字（百分数值），能读到几年就给几年（优先最近约 10 年），读不到的年份绝不补、不估算。口径：${job.caliber}。key 固定写 "${job.key}"，source 写发布机构名。\n\n证据：\n${ev}`,
        { schema: m2SeriesSchema },
      );
      const s = one.series.find((x) => x.key === job.key && x.points.length);
      if (s) m2Found.push(s);
    } catch {
      // this market stays 未查到 this pass; the next slow pass retries
    }
  }

  // --- TW baseline: verified series from CBC's Financial Statistics -------
  // Monthly (貨幣總計數 table, M2 daily-average balances). The prior
  // verification round recomputed the full 2015–2025 annual-average
  // growth series from the monthly balances in the 2026-10 issue and
  // anchored it twice against CBC's own published figures: 2025
  // recomputes to +4.54%, exactly CBC's published full-year average
  // growth (and the mean of CBC's published 2025 monthly YoY prints);
  // 2024 recomputes to +5.83%, exactly the value already landed from
  // CBC's published annual figure. The baseline therefore enters as a
  // verified curated entry — the same status as the IN backbone below:
  // distilled points may only ADD years the baseline does not cover
  // (i.e. 2026 onward), never override it. Full provenance and the
  // recomputation are recorded in DATA-PLAN.
  const TW_M2_BASELINE: Array<{ year: number; value: number }> = [
    { year: 2015, value: 6.34 },
    { year: 2016, value: 4.51 },
    { year: 2017, value: 3.75 },
    { year: 2018, value: 3.52 },
    { year: 2019, value: 3.46 },
    { year: 2020, value: 5.84 },
    { year: 2021, value: 8.72 },
    { year: 2022, value: 7.48 },
    { year: 2023, value: 6.25 },
    { year: 2024, value: 5.83 },
    { year: 2025, value: 4.54 },
  ];
  {
    const distilled = m2Found.find((s) => s.key === "m2_tw");
    const have = new Set(TW_M2_BASELINE.map((p) => p.year));
    const extra = (distilled?.points ?? []).filter((p) => !have.has(p.year));
    const merged = [...TW_M2_BASELINE, ...extra].sort(
      (a, b) => a.year - b.year,
    );
    const meta = M2_MARKETS.find((m) => m.code === "TW");
    const entry = {
      key: "m2_tw",
      points: merged,
      source: meta?.source ?? "中央银行《金融统计月报》（M2 日平均余额）",
    };
    const idx = m2Found.findIndex((s) => s.key === "m2_tw");
    if (idx >= 0) m2Found[idx] = entry;
    else m2Found.push(entry);
  }

  // --- IN backbone: RBI's published money-stock tables ----------------------
  // Deterministic, no inference: (a) the Handbook of Statistics'
  // "Components of Money Stock" annual table (RBI publications site)
  // lists end-March Broad Money (M3) in ₹ crore back to 1970 in clean
  // HTML — its edition ends at 2022-23; (b) two archived RBI Bulletin
  // money-stock tables supply the March columns for 2023-24 and
  // 2024-25 in the same caliber. Distilled points (above) may only fill
  // years AFTER the parsed range, never override it. Any fetch/parse
  // failure leaves the distilled result (or the previous stored entry)
  // untouched.
  try {
    const march = new Map<number, number>();
    const annualRes = await fetchWithTimeout(
      "https://rbi.org.in/SCRIPTS/PublicationsView.aspx?id=21846",
      20_000,
    );
    if (annualRes.ok) {
      const html = await annualRes.text();
      const rowRe =
        /<td>(\d{4})-\d\d<\/td>((?:\s*<td align="right">[\d,]+<\/td>)+)/g;
      for (const m of html.matchAll(rowRe)) {
        const cells = [...m[2]!.matchAll(/>([\d,]+)</g)].map((c) =>
          Number(c[1]!.replace(/,/g, "")),
        );
        const broad = cells[cells.length - 1];
        if (broad && Number.isFinite(broad)) {
          march.set(Number(m[1]) + 1, broad);
        }
      }
    }
    // Bulletin money-stock tables: header "Outstanding as on March 31/
    // …" followed by the fiscal-year label; the M3 row's first figure
    // is that March's stock (₹ crore, headline caliber excl. merger).
    for (const bulletinId of [23336, 24050]) {
      try {
        const res = await fetchWithTimeout(
          `https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx?Id=${bulletinId}`,
          20_000,
        );
        if (!res.ok) continue;
        const text = (await res.text())
          .replace(/<[^>]+>/g, "|")
          .replace(/\s+/g, " ");
        const fy = text.match(/March 31[^0-9]{0,120}?(20\d\d)-\d\d/);
        const m3 = text.match(/M3 \(3 \+ 6\)[^0-9]{0,40}?([\d,]{7,})/);
        if (fy && m3) {
          const level = Number(m3[1]!.replace(/,/g, ""));
          if (Number.isFinite(level) && level > 0) {
            march.set(Number(fy[1]) + 1, level);
          }
        }
      } catch {
        // this bulletin page unavailable; the rest of the backbone stands
      }
    }
    if (march.size) {
      const parsed: Array<{ year: number; value: number }> = [];
      for (const y of [...march.keys()].sort((a, b) => a - b)) {
        const prev = march.get(y - 1);
        const cur = march.get(y);
        if (y >= 2015 && prev != null && cur != null && prev !== 0) {
          parsed.push({
            year: y,
            value: Number((((cur - prev) / prev) * 100).toFixed(2)),
          });
        }
      }
      if (parsed.length) {
        const distilled = m2Found.find((s) => s.key === "m2_in");
        const have = new Set(parsed.map((p) => p.year));
        const extra = (distilled?.points ?? []).filter(
          (p) => !have.has(p.year),
        );
        const merged = [...parsed, ...extra].sort((a, b) => a.year - b.year);
        const entry = {
          key: "m2_in",
          points: merged,
          source: "印度储备银行货币库存构成年表（M3，3 月末存量）",
        };
        const idx = m2Found.findIndex((s) => s.key === "m2_in");
        if (idx >= 0) m2Found[idx] = entry;
        else m2Found.push(entry);
      }
    }
  } catch {
    // distilled-only this pass
  }

  if (!items.length && !m2Found.length) return;
  const now = Date.now();

  // --- Write rates + rents ---------------------------------------------------
  if (items.length) {
    const rateItems = items.filter((i) => !i.key.startsWith("rent_"));
    const oldCurated = (curated ?? []) as Array<Record<string, unknown>>;
    // Merge-keep: previously grounded values that this pass could not
    // re-confirm stay (with their original source/as-of); keys retired
    // in the 2026-11-14 step-1 change (cn_repo7d, old rent cities) drop
    // out because they are no longer in CURATED_KEYS.
    const mergedRates = [...rateItems];
    for (const old of oldCurated) {
      const k = old.key as string;
      if (
        (CURATED_KEYS as readonly string[]).includes(k) &&
        !k.startsWith("rent_") &&
        !mergedRates.some((m) => m.key === k)
      ) {
        mergedRates.push(old as (typeof rateItems)[number]);
      }
    }
    const ratesData = (rates?.data ?? {}) as Record<string, unknown>;
    await writeBlock(db, "rates", {
      source: rates?.source ?? "FRED + 各国央行官方发布",
      asOf: rates?.asOf ?? "",
      status: rates?.status ?? "ok",
      fetchedAt: rates?.fetchedAt ?? now,
      data: { ...ratesData, curated: mergedRates },
    });

    // Rents: convert to the unified caliber — CNY per month for an
    // 80㎡ two-bedroom estimate — using the day's Frankfurter rates.
    // Conversion happens here (server-side) so the card never mixes
    // currencies; if FX or the raw number is unavailable the item keeps
    // its original-currency string and says so in its detail.
    // FX for the conversion: units-per-USD for every rent currency.
    // Frankfurter (ECB reference rates) first; open.er-api.com (the
    // dashboard's standing FX backup) fills any currency Frankfurter
    // lacks — notably TWD, which is not an ECB reference currency.
    let fx: { date: string; perUsd: Record<string, number> } | null = null;
    const FX_SYMBOLS = "CNY,JPY,CAD,TWD,GBP,INR,CHF,EUR";
    try {
      const j = (await fetchJson(
        `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${FX_SYMBOLS}`,
      )) as { date?: string; rates?: Record<string, number> };
      if (j.rates?.CNY) {
        fx = { date: j.date ?? "", perUsd: { ...j.rates } };
      }
    } catch {
      fx = null;
    }
    try {
      const j = (await fetchJson("https://open.er-api.com/v6/latest/USD")) as {
        rates?: Record<string, number>;
      };
      if (j.rates?.CNY) {
        if (!fx) fx = { date: "", perUsd: {} };
        for (const [k, v] of Object.entries(j.rates)) {
          if (typeof v === "number" && v > 0 && fx.perUsd[k] == null) {
            fx.perUsd[k] = v;
          }
        }
      }
    } catch {
      // Frankfurter-only this pass
    }
    /** CNY per one unit of `code` (null when no rate is available). */
    const cnyPer = (code: string): number | null => {
      if (!fx) return null;
      if (code === "CNY") return 1;
      const per = fx.perUsd[code];
      const usdCny = fx.perUsd.CNY;
      return per && usdCny ? usdCny / per : null;
    };
    const fmtCny = (v: number) =>
      `约 ${Math.round(v).toLocaleString("en-US")} 元/月`;
    type RentItem = (typeof items)[number] & { cny?: number | null };
    const rentItems: RentItem[] = items
      .filter((i) => i.key.startsWith("rent_"))
      .map((i) => {
        const out: RentItem = { ...i, cny: null };
        if (typeof i.num === "number" && i.num > 0) {
          // Per-m² calibers (Shanghai/Tokyo/Zurich/Paris): ×80 first,
          // then convert. Total-rent calibers (New York/Toronto/Taipei/
          // London/Mumbai): convert the total directly. `fxCode` is the
          // item's own currency; `perSqm` marks the ×80 branch.
          const PER_SQM: Record<
            string,
            { code: string; unit: string }
          > = {
            rent_shanghai: { code: "CNY", unit: "元/㎡·月" },
            rent_tokyo: { code: "JPY", unit: "円/㎡·月" },
            rent_zurich: { code: "CHF", unit: "CHF/㎡·月" },
            rent_paris: { code: "EUR", unit: "€/㎡·月" },
          };
          const TOTAL: Record<string, { code: string; symbol: string }> = {
            rent_new_york: { code: "USD", symbol: "$" },
            rent_toronto: { code: "CAD", symbol: "C$" },
            rent_taipei: { code: "TWD", symbol: "NT$" },
            rent_london: { code: "GBP", symbol: "£" },
            rent_mumbai: { code: "INR", symbol: "₹" },
          };
          const sqm = PER_SQM[i.key];
          const tot = TOTAL[i.key];
          if (sqm) {
            const rate = cnyPer(sqm.code);
            const localTotal = i.num * 80;
            out.detail =
              sqm.code === "CNY"
                ? `${i.num} ${sqm.unit} × 80㎡`
                : `${i.num.toLocaleString("en-US")} ${sqm.unit} × 80㎡ = ${Math.round(localTotal).toLocaleString("en-US")} ${sqm.code === "JPY" ? "円" : sqm.code}，按 ${fx?.date ?? "当日"} 汇率折算`;
            if (rate) {
              const cny = localTotal * rate;
              out.cny = Math.round(cny);
              out.value = fmtCny(cny);
            }
          } else if (tot) {
            const rate = cnyPer(tot.code);
            out.detail = `${i.detail ?? ""}${i.detail ? " · " : ""}原值 ${tot.symbol}${i.num.toLocaleString("en-US")}/月，按 ${fx?.date ?? "当日"} 汇率折算`;
            if (rate) {
              const cny = i.num * rate;
              out.cny = Math.round(cny);
              out.value = fmtCny(cny);
            }
          }
        }
        return out;
      });
    const oldRents = await readBlock(db, "rents");
    const oldRentItems =
      ((oldRents?.data ?? {}) as Record<string, unknown>).items as
        | Array<Record<string, unknown>>
        | undefined;
    const RENT_ORDER = [
      "rent_new_york",
      "rent_toronto",
      "rent_shanghai",
      "rent_taipei",
      "rent_tokyo",
      "rent_london",
      "rent_mumbai",
      "rent_zurich",
      "rent_paris",
    ];
    const mergedRents = [...rentItems];
    for (const old of oldRentItems ?? []) {
      const k = old.key as string;
      if (
        RENT_ORDER.includes(k) &&
        !mergedRents.some((m) => m.key === k)
      ) {
        mergedRents.push(old as RentItem);
      }
    }
    mergedRents.sort(
      (a, b) => RENT_ORDER.indexOf(a.key) - RENT_ORDER.indexOf(b.key),
    );
    await writeBlock(db, "rents", {
      source: "租金指数/发布值逐条标注 · 统一折人民币（Frankfurter 当日汇率）",
      asOf: rentItems[0]?.asOf ?? oldRents?.asOf ?? "",
      status: "ok",
      fetchedAt: now,
      data: { items: mergedRents },
    });
  }

  // --- Write curated M2 entries (auto entries are preserved) -----------------
  if (m2Found.length) {
    const m2Block = await readBlock(db, "m2");
    const cur = new Map<string, M2Entry>();
    const curCountries = ((m2Block?.data ?? {}) as Record<string, unknown>)
      .countries as Array<Record<string, unknown>> | undefined;
    for (const c of curCountries ?? []) {
      if (typeof c.code === "string") {
        cur.set(c.code, c as unknown as M2Entry);
      }
    }
    const keyToCode: Record<string, string> = {
      m2_tw: "TW",
      m2_in: "IN",
    };
    for (const s of m2Found) {
      const code = keyToCode[s.key];
      if (!code) continue;
      const meta = M2_MARKETS.find((m) => m.code === code);
      if (!meta) continue;
      const pts = [...s.points]
        .filter((p) => Number.isFinite(p.year) && Number.isFinite(p.value))
        .sort((a, b) => a.year - b.year)
        .slice(-11);
      if (!pts.length) continue;
      cur.set(code, {
        code,
        name: meta.name,
        measure: meta.measure,
        basis: meta.basis,
        latestYear: pts[pts.length - 1]!.year,
        latestValue: pts[pts.length - 1]!.value,
        points: pts,
        // 来源行统一用 M2_MARKETS 的「机构＋数据产品」写法（台湾行
        // 此前只落成蒸馏给的「台湾中央银行」，2026-11-14 收尾轮改齐）。
        source: meta.source,
      });
    }
    const countries = M2_MARKETS.map(
      (m) => cur.get(m.code) ?? emptyM2Entry(m),
    );
    await writeBlock(db, "m2", {
      source:
        m2Block?.source ??
        "各国央行官方序列（逐行标注）",
      asOf: m2Block?.asOf ?? "",
      status: m2Block?.status ?? "ok",
      fetchedAt: m2Block?.fetchedAt ?? now,
      data: { countries },
    });
  }

  // The pass genuinely fetched and stored new curated values: advance
  // the slow pass's own timestamp (and only here — failed/empty passes
  // above returned early without touching it, so a broken source can
  // never freeze the data for another 20 h by faking freshness).
  await markSlowCuratedFetched(db, now);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// One-time import: Cap 7 early year-end point, 2023-12-19 (user,
// 2026-11-14: 「Cap 7 去挖 2020–2023 年存档，趋势补长了再统一」).
// The all-countries page's earliest Wayback capture is 2023-02-20,
// so NO capture exists within ±45 days of the 2020 / 2021 / 2022
// year-ends (2022's nearest is 51 days out and was NOT used); the
// only obtainable year-end point is the last 2023 capture,
// 2023-12-19 (12 days before year-end), staged at
// ~/workspace/finance-globe-export/cap7-history-2023.json. This
// action reads it through the privileged channel, verifies its
// SHA-256 against the approved value BEFORE parsing anything
// (mismatch = abort, nothing imported), then writes the 10 markets'
// points into history_points (series "cap:<CODE>") with their
// company counts and source="wayback-backfill-early", the TRUE date
// 2023-12-19 kept. Idempotent: a (series, date) that already exists
// is never overwritten. NO cap:TOTAL point is written: this file's
// total is the page HEADLINE total, a different denominator basis
// from the backfill's per-row sums, and the point exists only as a
// trend-line level reference (its coverage is far thinner — JP 349
// companies vs 944 now — so it is never a growth base; the client
// draws its segment dashed / dim). After writing, the country_caps
// block is rebuilt through the normal live refresh path. This
// action is one-time by intent; its removal rides along with the
// next edit (the same rule retired importCap7ArchiveBackfill in
// this edit).
// ---------------------------------------------------------------------------

const CAP7_EARLY2023_EXPECTED_SHA256 =
  "39359b2289a6af51a0a4db5c2707c6271efe3a7202862b15185efe880eacbd0b";
const CAP7_EARLY2023_CODES = [
  "US",
  "CA",
  "CN",
  "TW",
  "JP",
  "GB",
  "IN",
  "CH",
  "FR",
  "KR",
] as const;
const CAP7_EARLY2023_DATE = "2023-12-19";

const cap7Early2023ImportResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  sha256: z.string().nullable(),
  expectedSha256: z.string(),
  sizeBytes: z.number().nullable(),
  pointDate: z.string().nullable(),
  markets: z.record(
    z.string(),
    z.object({ marketCapUsd: z.number(), companies: z.number() }),
  ),
  insertedBySeries: z.record(z.string(), z.number()),
  skippedExisting: z.record(z.string(), z.number()),
  totalInserted: z.number(),
  note: z.string(),
});

async function loadDashboard(ctx: Ctx): Promise<z.infer<typeof dashboardResponse>> {
  const db = ctx.db<typeof schema>();
  const [fx, mag7, rates, m2, rents, volatility, cables, countryCaps] =
    await Promise.all([
      readBlock(db, "fx"),
      readBlock(db, "mag7"),
      readBlock(db, "rates"),
      readBlock(db, "m2"),
      readBlock(db, "rents"),
      readBlock(db, "volatility"),
      readBlock(db, "cables"),
      readBlock(db, "country_caps"),
    ]);
  let mag7TotalChange30d: number | null = null;
  try {
    const pts = await db
      .select()
      .from(schema.historyPoints)
      .where(eq(schema.historyPoints.series, "mag7_total_v2"));
    const sorted = pts.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = sorted[sorted.length - 1];
    if (last && sorted.length > 1) {
      const cutoff = new Date(Date.now() - 30 * 86400_000)
        .toISOString()
        .slice(0, 10);
      // The base must sit on the same (merged) basis at least 30 days
      // back. Until the v2 series is 30 days old there is no honest
      // 30-day change, so the readout stays hidden (null) instead of
      // quietly becoming a since-merge or mixed-basis figure.
      const base = sorted.filter((p) => p.date <= cutoff).pop();
      if (base && base.value !== 0 && base.date !== last.date) {
        mag7TotalChange30d = Number(
          (((last.value - base.value) / base.value) * 100).toFixed(2),
        );
      }
    }
  } catch {
    mag7TotalChange30d = null;
  }
  return {
    generatedAt: Date.now(),
    fx,
    mag7,
    rates,
    m2,
    rents,
    volatility,
    cables,
    countryCaps,
    mag7TotalChange30d,
    refreshTimings: null,
  };
}

const exportSnapshotResponse = z.object({
  path: z.string(),
  manifestPath: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
});

export const Actions = {
  exportDashboardSnapshot: defineAction({
    description:
      "Exports the complete getDashboard payload (all blocks, full 30-point spark arrays, nothing trimmed) as JSON to the host workspace at ~/workspace/finance-globe-export/dashboard-full.json, plus a manifest.json in the same directory recording the file's byte size and SHA-256 computed from the bytes actually written to disk. Idempotent: re-running overwrites with the current payload.",
    request: z.object({}),
    response: exportSnapshotResponse,
    privileged: [privileged.writeDashboardExport],
    async handler(ctx): Promise<z.infer<typeof exportSnapshotResponse>> {
      // Same loader getDashboard uses: the full cached payload, spark
      // arrays included, serialized as-is.
      const payload = await loadDashboard(ctx);
      const json = `${JSON.stringify(payload, null, 2)}\n`;
      return ctx.executePrivileged(privileged.writeDashboardExport, {
        json,
      });
    },
  }),

  importCap7Early2023: defineAction({
    description:
      "One-time import of the approved Cap 7 early year-end archive point (2023-12-19, the only 2020–2023 year-end the Wayback Machine holds for the all-countries page): verifies the staged file's SHA-256 (aborts untouched on mismatch), then inserts the 10 markets' market caps + company counts with source=wayback-backfill-early into the cap:<CODE> history series without ever overwriting an existing point, and rebuilds the country-caps block. No cap:TOTAL point is written (the file's total is the page headline figure, a different basis). Idempotent — safe to run again; it reports inserted vs already-present counts per series plus the imported values.",
    request: z.object({}),
    response: cap7Early2023ImportResponse,
    privileged: [privileged.readCap7Early2023],
    async handler(
      ctx,
    ): Promise<z.infer<typeof cap7Early2023ImportResponse>> {
      const fail = (
        error: string,
        extra?: Partial<z.infer<typeof cap7Early2023ImportResponse>>,
      ): z.infer<typeof cap7Early2023ImportResponse> => ({
        ok: false,
        error,
        sha256: null,
        expectedSha256: CAP7_EARLY2023_EXPECTED_SHA256,
        sizeBytes: null,
        pointDate: null,
        markets: {},
        insertedBySeries: {},
        skippedExisting: {},
        totalInserted: 0,
        note: "",
        ...extra,
      });
      let file: { content: string; sizeBytes: number; sha256: string };
      try {
        file = await ctx.executePrivileged(privileged.readCap7Early2023, {});
      } catch (e) {
        return fail(
          `存档文件读取失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Hash gate FIRST: unverified bytes are never parsed or imported.
      if (file.sha256 !== CAP7_EARLY2023_EXPECTED_SHA256) {
        return fail(
          "存档文件 SHA-256 与批准值不符，已中止导入，未写入任何数据",
          { sha256: file.sha256, sizeBytes: file.sizeBytes },
        );
      }
      let parsed: {
        points?: Array<{
          date?: string;
          markets?: Record<
            string,
            { marketCapUsd?: number; companies?: number } | undefined
          >;
        }>;
      };
      try {
        parsed = JSON.parse(file.content) as typeof parsed;
      } catch {
        return fail("存档文件 JSON 解析失败，已中止导入", {
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        });
      }
      const points = parsed.points ?? [];
      if (points.length !== 1) {
        return fail(
          `存档文件点数异常（期望 1，实际 ${points.length}），已中止导入`,
          { sha256: file.sha256, sizeBytes: file.sizeBytes },
        );
      }
      const point = points[0]!;
      if (point.date !== CAP7_EARLY2023_DATE || !point.markets) {
        return fail(
          `存档点日期/市场数据异常（期望 ${CAP7_EARLY2023_DATE}），已中止导入`,
          { sha256: file.sha256, sizeBytes: file.sizeBytes },
        );
      }
      const markets: Record<
        string,
        { marketCapUsd: number; companies: number }
      > = {};
      for (const code of CAP7_EARLY2023_CODES) {
        const v = point.markets[code];
        if (
          !v ||
          typeof v.marketCapUsd !== "number" ||
          !(v.marketCapUsd > 0) ||
          typeof v.companies !== "number" ||
          !(v.companies > 0)
        ) {
          return fail(
            `存档点缺少 ${code} 的市值/公司数，已中止导入`,
            { sha256: file.sha256, sizeBytes: file.sizeBytes },
          );
        }
        markets[code] = {
          marketCapUsd: v.marketCapUsd,
          companies: v.companies,
        };
      }
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.historyPoints)
        .where(like(schema.historyPoints.series, "cap:%"));
      const existingKeys = new Set(
        existing.map((r) => `${r.series}|${r.date}`),
      );
      const insertedBySeries: Record<string, number> = {};
      const skippedExisting: Record<string, number> = {};
      let totalInserted = 0;
      for (const code of CAP7_EARLY2023_CODES) {
        const series = `cap:${code}`;
        const v = markets[code]!;
        if (existingKeys.has(`${series}|${CAP7_EARLY2023_DATE}`)) {
          skippedExisting[series] = 1;
          continue;
        }
        await db.insert(schema.historyPoints).values({
          series,
          date: CAP7_EARLY2023_DATE,
          value: v.marketCapUsd,
          companies: v.companies,
          source: "wayback-backfill-early",
        });
        existingKeys.add(`${series}|${CAP7_EARLY2023_DATE}`);
        insertedBySeries[series] = 1;
        totalInserted += 1;
      }
      // Rebuild the country_caps block through the normal refresh so
      // the yearly trend picks the point up right away. If the live
      // fetch fails the block keeps its previous values marked stale
      // and the daily refresh rebuilds it — the imported point
      // itself is durable.
      await refreshCountryCapsSection(db);
      ctx.invalidateQueries();
      const skipped = Object.keys(skippedExisting);
      return {
        ok: true,
        error: null,
        sha256: file.sha256,
        expectedSha256: CAP7_EARLY2023_EXPECTED_SHA256,
        sizeBytes: file.sizeBytes,
        pointDate: CAP7_EARLY2023_DATE,
        markets,
        insertedBySeries,
        skippedExisting,
        totalInserted,
        note:
          "SHA-256 校验通过；2023-12-19 存档点按真实日期写入 10 个市场，公司数与 source=wayback-backfill-early 随点保存。" +
          "未写 cap:TOTAL（文件总数为页面页眉口径，与回填的逐行加总口径不同）。" +
          "该点收录公司数远少于现在（仅作趋势线水位参考，不作涨幅基点；近 12 个月窗口不触及它）。" +
          (skipped.length
            ? ` 已存在的同日点未覆盖：${skipped.join("、")}。`
            : " 无同日冲突点。") +
          " 导入后已走正常刷新路径重建 country_caps 板块。",
      };
    },
  }),

  getDashboard: defineAction({
    description:
      "Returns the full macro dashboard (FX, Mag7, rates, M2, rents, volatility) from the latest cached snapshots IMMEDIATELY — stale-while-revalidate: it never blocks on source refreshes when a snapshot exists, however old. Only a completely empty snapshot store (first-ever load) refreshes inline, since there is nothing to show otherwise. Freshness is the client's job: it renders this payload at once, then calls refreshData in the background and swaps in changed values.",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<z.infer<typeof dashboardResponse>> {
      const db = ctx.db<typeof schema>();
      const mag7 = await readBlock(db, "mag7");
      const fx = await readBlock(db, "fx");
      if (!mag7 || !fx) {
        // Cold start only: no snapshot to paint, so this one load waits.
        await refreshFast(ctx);
        // Slow curated values ride along opportunistically on first load.
        await refreshSlow(ctx, false);
      }
      return loadDashboard(ctx);
    },
  }),

  refreshData: defineAction({
    description:
      "Refreshes all dashboard data from its sources: fast market data every call, slow curated values (nine-market central-bank policy rates, nine-city rents in unified CNY caliber, two curated M2 annual series for TW/IN) when older than 20 hours or when forceSlow is set.",
    request: z.object({
      forceSlow: z.boolean().default(false),
    }),
    response: dashboardResponse,
    async handler(ctx, args): Promise<z.infer<typeof dashboardResponse>> {
      const timings = await refreshFast(ctx);
      const slowT0 = Date.now();
      await refreshSlow(ctx, args.forceSlow);
      timings.slowCurated = Date.now() - slowT0;
      ctx.invalidateQueries();
      const dash = await loadDashboard(ctx);
      return { ...dash, refreshTimings: timings };
    },
  }),
} satisfies ActionsModule;
