/**
 * One colour table is the single source of truth for the whole globe:
 * nodes, labels, map highlights, arc colours, the legend and the
 * summary cards all read from here, so nothing can drift.
 *
 * Colour answers "whose line is this?" — it encodes the COUNTRY of an
 * arc's endpoints. Financial tier never touches colour; it drives
 * weight/brightness/height/density instead (see arcs.ts).
 *
 * All country colours sit in one lightness band so no country shouts
 * louder than another just by saturation.
 */

export interface CountryStyle {
  /** Arc core / node colour. */
  color: string;
  /** Lighter same-family shade (e.g. a same-country hub). */
  soft: string;
}

export const COUNTRY_COLORS: Record<string, CountryStyle> = {
  US: { color: "#38b6e8", soft: "#8fd4f2" }, // 青蓝
  CN: { color: "#e8544a", soft: "#f0938a" }, // 暖红
  HK: { color: "#f0836f", soft: "#f5ab9c" }, // red family, one shade lighter than CN
  JP: { color: "#f2a7c3", soft: "#f7c9da" }, // 粉樱
  GB: { color: "#9a7ee8", soft: "#bdaef2" },
  DE: { color: "#e8c33a", soft: "#f2da85" },
  SG: { color: "#e88f3a", soft: "#f2b183" },
  CH: { color: "#e8e3da", soft: "#f4f1ec" },
  FR: { color: "#5a7ee8", soft: "#94a9f2" },
  CA: { color: "#e85a7a", soft: "#f294a9" },
  AU: { color: "#3ac98f", soft: "#85dcb8" },
  KR: { color: "#7a5ae8", soft: "#a78ff2" },
  IN: { color: "#e8743a", soft: "#f2a183" },
  AE: { color: "#3aa7c9", soft: "#85c6dc" },
  BR: { color: "#5ac93a", soft: "#94dc85" },
  ZA: { color: "#c93a8f", soft: "#dc85b8" },
  RU: { color: "#8f9aa8", soft: "#bcc3cc" },
  IT: { color: "#3ac95a", soft: "#85dc9e" },
  ES: { color: "#e8a83a", soft: "#f2ca85" },
};

const FALLBACK: CountryStyle = { color: "#aab4c0", soft: "#ccd3da" };

export function countryStyle(countryCode: string): CountryStyle {
  return COUNTRY_COLORS[countryCode] ?? FALLBACK;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Colour at arc parameter t (0 = origin, 1 = destination).
 * Same-country arcs are a pure colour; cross-country arcs gradient
 * along their length — particles and comet tails sample this same
 * function, and the arrival ripple uses the destination colour.
 */
export function arcColorAt(fromCountry: string, toCountry: string, t: number): string {
  const a = hexToRgb(countryStyle(fromCountry).color);
  const b = hexToRgb(countryStyle(toCountry).color);
  return rgbToHex([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

/** Financial tier by endpoint combination: both tier-1 → 1; any tier-3
 *  endpoint → 3; otherwise 2. Tier drives ONLY physical emphasis. */
export type Tier = 1 | 2 | 3;

const TIER1 = new Set(["US", "GB", "HK", "SG", "JP", "CN"]);
const TIER3 = new Set(["ZA", "BR", "RU", "IN"]);

export function arcTier(fromCountry: string, toCountry: string): Tier {
  if (TIER3.has(fromCountry) || TIER3.has(toCountry)) return 3;
  if (TIER1.has(fromCountry) && TIER1.has(toCountry)) return 1;
  return 2;
}

export const TIER_EMPHASIS: Record<Tier, {
  coreWidth: number; brightness: number; arcHeight: number;
  particleSize: number; particleDensity: number; particleSpeed: number;
}> = {
  1: { coreWidth: 1.6, brightness: 1.0, arcHeight: 0.32, particleSize: 1.5, particleDensity: 3, particleSpeed: 1.0 },
  2: { coreWidth: 1.1, brightness: 0.75, arcHeight: 0.22, particleSize: 1.1, particleDensity: 2, particleSpeed: 0.8 },
  3: { coreWidth: 0.7, brightness: 0.5, arcHeight: 0.14, particleSize: 0.8, particleDensity: 1, particleSpeed: 0.6 },
};
