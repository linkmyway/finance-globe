/**
 * Lighting rig + comet-particle arc animation.
 *
 * Lighting — day/night is a sun-DIRECTION problem:
 * with the sun pointing too much toward the viewer, ~77% of the disc is
 * lit. A near-side warm key light, ambient/fill dialled down and a deep
 * night side restore a ≈50/50 terminator and let city lights pop.
 * There is no painted terminator band; the transition comes from the
 * lighting alone, nearly a hard edge.
 */

export const LIGHTING = {
  /** The sun: one warm key light, near-tangential to the view axis. */
  sunColor: 0xffd9a3, // warm gold, never white
  sunIntensity: 2.4,
  /** Direction chosen so the lit fraction stays ≈ 0.5 with small drift
   *  as the globe rotates (mostly sideways, slight toward-viewer). */
  sunDirection: { x: 1.0, y: 0.25, z: 0.18 },
  ambientIntensity: 0.5, // was 1.15 — washed out the night side
  fillColor: 0x6a86b8, // cool fill
  fillIntensity: 0.32, // was 0.85
  /** How deep the night side falls toward blue-black. */
  nightDepth: 0.8, // was 0.55
  /** City-light residual allowed on the day side (3%): lights read
   *  only at night. */
  dayLightResidual: 0.03,
  /** Default camera pitch: financial centres cluster in the north. */
  cameraPitchDeg: 27.5,
} as const;

/**
 * Rotation pause/resume — the drag-lock lesson:
 * a previous build released the "hold" only on node click, so the
 * globe stuck paused after ordinary drags. Release the hold on ALL of:
 * pointer-up, gesture cancel, auto-rotate toggle, selection change.
 */
export class RotationHold {
  private held = false;
  hold() { this.held = true; }
  release() { this.held = false; }
  get isHeld() { return this.held; }
  /** Auto-rotation advances only when not held. */
  shouldRotate(userEnabled: boolean) { return userEnabled && !this.held; }
}

/* ------------------------------------------------------------------ */
/* Comet particles                                                     */
/* ------------------------------------------------------------------ */

import { arcColorAt, arcTier, TIER_EMPHASIS, type Tier } from "./country-colors";

export interface Arc {
  fromCountry: string;
  toCountry: string;
  tier: Tier;
  /** Particle phases in [0,1), staggered. */
  particles: number[];
  /** Expanding arrival ripples: progress in [0,1). */
  ripples: number[];
}

export function makeArc(fromCountry: string, toCountry: string): Arc {
  const tier = arcTier(fromCountry, toCountry);
  const n = TIER_EMPHASIS[tier].particleDensity;
  return {
    fromCountry,
    toCountry,
    tier,
    particles: Array.from({ length: n }, (_, i) => i / n),
    ripples: [],
  };
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t * t;
/** Departure fast, approach slow: blend ease-out → ease-in along t. */
export function cometEase(t: number): number {
  return t < 0.5 ? easeOut(t * 2) * 0.5 : 0.5 + easeIn((t - 0.5) * 2) * 0.5;
}

export interface ParticleDot {
  /** Arc parameter after easing. */
  t: number;
  color: string;
  /** 0 = head; 1..8 = tail points, fading. */
  tailIndex: number;
  opacity: number;
  size: number;
}

const TAIL = 8;

/** Advance one arc by dt seconds; returns this frame's drawable dots. */
export function stepArc(arc: Arc, dt: number): ParticleDot[] {
  const em = TIER_EMPHASIS[arc.tier];
  const dots: ParticleDot[] = [];
  arc.particles = arc.particles.map((phase) => {
    const next = phase + dt * 0.08 * em.particleSpeed;
    if (next >= 1) {
      arc.ripples.push(0); // arrival → ripple in destination colour
      return next - 1;
    }
    return next;
  });
  for (const phase of arc.particles) {
    const headT = cometEase(phase);
    for (let k = 0; k <= TAIL; k++) {
      const t = Math.max(0, headT - k * 0.012);
      dots.push({
        t,
        color: arcColorAt(arc.fromCountry, arc.toCountry, t),
        tailIndex: k,
        // Bright pulsing head; tail fades geometrically.
        opacity: k === 0 ? 0.85 + 0.15 * Math.sin(performance.now() / 300) : Math.pow(0.72, k),
        size: em.particleSize * (k === 0 ? 1 : 1 - k * 0.07),
      });
    }
  }
  // Ripples expand and die; the renderer draws them at the destination
  // node with radius = progress, alpha = 1 - progress.
  arc.ripples = arc.ripples.map((r) => r + dt * 0.9).filter((r) => r < 1);
  return dots;
}
