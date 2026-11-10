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

## Features and implementation, in detail

Feature by feature: what it does, how it is built, and where its
edges are. Where this section and earlier summaries differ, this
section governs.

### The globe and base map

- What: a draggable, auto-rotating night-style 3D earth with
  continents, borders and three highlighted focus countries.
- How: Natural Earth 50m filled continents + border lines; the
  camera defaults to a ~27.5° downward pitch (financial centres
  cluster in the northern hemisphere — a composition decision, not
  an arbitrary value). The WebGL scene layers globe, lights, nodes,
  arcs and cable bands independently.
- Edges: the geographic data files are build products (sources and
  encodings in the payload ledger below), not repo content.

### City lights

- What: city light points that come alive on the night side — the
  more developed the city, the denser and brighter.
- How: ~15k population-weighted light points, compactly encoded.
  Lights live by contrast: their day-side residual is clamped to ~3%
  (see the lighting model), so they read only where the lighting
  model says night is.
- Edges: the light field is static geography; "lit = night city" is
  an outcome of the lighting, not a per-point switch.

### Day/night lighting and the real sun

- What: half the disc is day, half night, and the terminator sits
  where the real world's does.
- How: one warm key light (0xffd9a3) is the sun, its direction
  computed from the **real sun position** for the current moment
  (Greenwich sidereal time based), fixed to geography and sweeping
  the disc as the globe turns. Ambient 0.50, cool fill 0.32, night
  depth 0.80. The lit fraction is governed by the sun direction's
  viewer-facing component: too much of it lit ~77% of the disc;
  a near-tangential sun returns it to ~50% with small oscillation.
  City labels carry local time (longitude + current time).
- Edges: no terminator band geometry — the transition comes from
  the lighting alone, nearly a hard edge (a painted warm band
  existed once and was removed on the owner's word).

### Financial-centre nodes

- What: the GFCI financial centres as nodes on the sphere, with
  city labels.
- How: nodes are pinned by lat/lng; labels use avoidance layout.
  Node colour comes from the same single country-colour table as
  the arcs and the legend — there is no second definition anywhere.
- Edges: the node set follows the GFCI list; no hand-added cities.

### Flowing arcs and comet particles

- What: flowing arcs between financial centres that answer "who
  connects to whom, at what weight" at a glance.
- How: two-layer arcs — a wide faint halo under a thin bright core,
  core fading at both ends, breathing slowly. Colour encodes the
  **endpoint countries** from the single colour table: same-country
  arcs are pure; cross-country arcs interpolate along the arc
  parameter, and particles and tails sample the same gradient;
  arrival ripples take the destination country's colour. Financial
  tier (1/2/3 by endpoint combination) drives only core width,
  brightness, arc height and particle size/density/speed — never
  colour. Particles are comets: one bright head + an 8-point fading
  tail, ease-out departure and ease-in arrival, staggered per arc,
  with an expanding ripple on arrival.
- Edges: editing the colour table restyles the whole site; a
  hard-coded colour inside a component counts as a regression.

### Data tiers, refresh, and stale-first rendering

- What: FX, quotes, policy rates, broad money, rents and volatility,
  each fresh at its own cadence.
- How: two refresh tiers — fast sources (ECB reference FX via
  Frankfurter, Mag7 quotes via Finnhub, FRED series, index quotes)
  refresh inline on dashboard reads when stale; slow curated values
  (some policy rates, rents) refresh only when older than ~20 h or
  forced. The front-end is **stale-first**: the last snapshot renders
  instantly, the background refresh then swaps in only the values
  that changed, and unrefreshed values keep an honest "data as of"
  label. There is no manual refresh button — it was merged into the
  status corner ("data as of HH:MM" plus a small text-less gold
  spinner while refreshing), on the owner's instruction. A daily
  scheduled job warms the cache. Every displayed value's payload
  carries its source and as-of time; homepage prose is compressed to
  1–2 lines per block, but provenance labels may be shortened, never
  deleted.
- Edges: a value that can't be sourced shows as missing, never as a
  stale or approximate number in disguise. Curated policy-rate
  entries track the issuing central bank's current framework (e.g.
  China's anchor rate follows the PBOC's published operating
  framework as it changes).

### Indicator panels

- What: the panel ring around the globe — FX pairs, CN/US/JP policy
  rates, Mag7 quotes and caps, M2 growth, five-city rents,
  volatility.
- How: panels consume only the aggregate dashboard payload (every
  value with source + as-of); none of them fetches on its own. (A
  past bug rendered only five of the Magnificent 7; the fix added a
  standing check: rendered row count must reconcile with payload row
  count.)
- Edges: no panel invents a fallback number.

### Submarine cables (section + on-globe bands)

- What: a homepage section listing the major submarine cables
  (region-filterable, with live status), and the cables drawn on the
  globe itself: deep-sea cyan flowing bands hugging the surface
  along the cables' real landing points and routes, turning red and
  pulsing on a reported fault — a visual language deliberately
  distinct from the finance arcs.
- How: the bands are a permanent globe layer (no toggle), geometry
  built from real landing points and route polylines, rendered
  surface-hugging; the flow effect is kin to the arc particles but
  an independent band system. Status is a **two-tier model**: red
  "reported fault" comes only from hard sources (news, operators,
  TeleGeography-grade reporting); a separate "corridor signal
  anomaly — unverified" tier aggregates network signals (IODA,
  Cloudflare Radar) over each cable's country-pair corridor — a
  signal, not a verdict, worded and coloured apart from hard faults.
  The fault ledger is kept per entry with source and date.
- Edges (the honesty line): **no public per-cable real-time
  telemetry exists.** With nothing reported, the status reads "no
  fault reports seen" — never "normal" or "healthy".

### Solar-system mode and the homepage planet

- What: a solar-system view with planets at their real-date
  positions (the Moon included). Tapping a planet there, then
  tapping again, makes it the homepage planet for the session; the
  homepage is that planet until reopen, when Earth returns as the
  default.
- How: planet positions are computed from the current date
  (Keplerian-element approximation), not hard-coded angles. The
  homepage planet's enter/return transitions travel from **its own
  orbital position and radius**: the handoff point is co-located and
  co-sized with the guest planet, a strict-identity handoff (an
  earlier version borrowed Earth's path for every planet and jumped;
  a frame-by-frame audit traced a handoff-frame diameter step and an
  opacity pop, and fixed it to three consecutive frames measuring
  identically). The bottom bar carries a planet menu: the button
  shows only the current planet's name; the menu lists ten bodies
  (the Sun, eight planets, the Moon), highlights the current one,
  is fixed-height and scrollable, and auto-scrolls the current entry
  into view. The solar view has its own "back to the solar system"
  control.
- Edges: the planet swap is session state, never persisted — the
  default is always Earth.

### Moon residents (paper-figure aliens)

- What: alien residents from a manga/anime franchise stand on the
  Moon's disc as paper figures — one species added per day, at a
  deliberately slow cadence (first resident: the Serpo).
- How: the figures are cutouts from official product photography of
  the licensed soft-vinyl figures (no official back view exists;
  a side view stands in, and that gap is documented, not papered
  over). Eye colours are painted per figure at measured positions.
  Each figure's feet align to the **local surface normal** with a
  contact shadow, so it stands on a slope instead of being pasted
  on. Whenever the Moon returns to the homepage, residents are
  re-seated in the disc's upper half (the owner's composition rule).
  Every species gets an appearance + habits dossier before it is
  built; the dossiers live in the archive's resident files.
- Edges: official artwork only; a missing angle is recorded as
  missing, never invented.

### Rotation, drag, pause/resume

- What: the globe auto-rotates; dragging takes over the view;
  releasing resumes rotation; node clicks and mode switches don't
  corrupt the rotation state.
- How: pause begins only on an explicit gesture (pointer-down /
  drag); resume is bound to pointer-up, gesture cancel, toggles and
  selection changes. The historical bug: resume was bound only to
  node clicks, so an ordinary drag locked rotation forever — the
  fix made resume multi-entry and total.
- Edges: rotation state is never persisted; a reload starts from
  the default pose (27.5° pitch).

### Mobile payload

- What: the globe must open fast on a phone.
- How: the measured ledger is in the data section above (compact
  geographic encodings −41% in total, main JS −23%, mobile texture
  halved). Stale-first rendering (above) is part of the same
  strategy: instant first paint from the snapshot, values quietly
  swapped as the refresh lands.
- Edges: the red line — speed never comes from cutting globe detail
  or effects; every optimisation ships with before/after
  measurements.
