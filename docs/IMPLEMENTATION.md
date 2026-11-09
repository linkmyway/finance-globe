# Implementation method

## Scene

- Base map: Natural Earth 50m filled continents + borders; three focus
  countries highlighted. ~15k population-weighted city-light points;
  financial-centre nodes (GFCI list) with labels and label-avoidance.
- Default camera pitched down ~27.5° (financial centres cluster in the
  northern hemisphere). Drag to rotate; auto-rotation resumes on
  release.

## Lighting model

- One warm key light (0xffd9a3) as the sun, direction near-tangential
  to the view axis → lit fraction ≈ 50% with small oscillation.
- Ambient 0.50, cool fill 0.32, night-depth 0.80: the night side sits
  near blue-black; city-light residual on the day side is clamped to
  ~3% so lights read only at night.
- No terminator band geometry; the day/night transition is produced by
  the lighting alone, nearly a hard edge.

## Arcs and particles

- Two-layer arcs: a wide faint halo under a thin bright core; core
  fades at both ends and breathes slowly. Arc height scales with tier.
- Particles: 1 bright head + 8-point fading tail per particle,
  ease-out → ease-in along the arc, multiple particles staggered;
  arrival triggers an expanding ripple in the destination colour.
- Colour system (single source of truth): one country → one colour
  (same lightness band); a special lighter shade distinguishes a
  same-country financial hub. Cross-country arcs interpolate colour by
  arc parameter; particles sample the same gradient.
- Tier (1/2/3 by endpoint combination) controls only: core width,
  brightness, arc height, particle size/density/speed.

## Data tiers and refresh

- **Fast tier** (refreshed on dashboard calls when stale): FX reference
  rates (Frankfurter/ECB), US equity quotes (Finnhub), FRED series
  (UST 2Y/10Y, effective fed funds, VIX), index quotes.
- **Slow tier** (refreshed when older than ~20 h or forced): policy
  rates entered as curated values with per-item source and as-of date
  (central-bank publications), city rents (published rent indices),
  broad-money annual growth (World Bank WDI).
- Every displayed value carries its source and as-of date in the data
  payload; the UI never shows a number whose provenance is not in the
  payload.
- A daily scheduled refresh warms the cache.

## Mobile payload ledger (measured)

| Asset | Before | After |
| --- | --- | --- |
| Country polygons | 369 KB | 162 KB |
| City lights | 322 KB | 143 KB |
| Land dots | 409 KB | 341 KB |
| Main JS bundle | 1.95 MB | 1.50 MB |
| Map texture (mobile) | 4096 wide / 33.5 MB VRAM | 2048 wide / 8.4 MB VRAM |

Constraint: size cuts come from encoding and resolution tiers only —
never from removing globe detail or effects.
