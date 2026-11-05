/**
 * A damped spring as a CSS `linear()` easing, for the release of a flicked toast.
 * Position runs from 0 to 1 and overshoots a little, like a real spring. The curve is
 * sampled once at module load and handed to CSS as a custom property, so the browser
 * still runs it on the compositor and an interrupted spring needs no JavaScript.
 */
export interface SpringOptions {
  /** Spring stiffness. Higher is faster. */
  stiffness?: number;
  /** Damping. Lower than 2 * sqrt(stiffness) overshoots. */
  damping?: number;
  /** Length of the curve in seconds. Past this it is treated as settled at 1. */
  seconds?: number;
  /** Number of samples; 28 is smooth enough for a 500ms move. */
  steps?: number;
}

export function springEasing({ stiffness = 380, damping = 26, seconds = 0.5, steps = 28 }: SpringOptions = {}): string {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const wd = w0 * Math.sqrt(Math.max(1 - zeta * zeta, 1e-6));
  const at = (t: number): number =>
    1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * seconds;
    const v = i === steps ? 1 : at(t);
    stops.push(i === 0 ? "0" : `${v.toFixed(4)} ${((i / steps) * 100).toFixed(1)}%`);
  }
  return `linear(${stops.join(", ")})`;
}

export const releaseSpring = springEasing();
