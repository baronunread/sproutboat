/** Real-time durations in ms, mirrored from tokens/tokens.ts for the playground's slow-motion control. */
import { motion } from "../src/tokens.generated";

/** Scales every duration token on <html> by `factor` (1 restores the stylesheet values) and mirrors it in --sb-slow. */
export function setSpeed(factor: number): void {
  const root = document.documentElement;
  for (const [name, ms] of Object.entries(motion.duration)) {
    if (factor === 1) root.style.removeProperty(`--sb-duration-${name}`);
    else root.style.setProperty(`--sb-duration-${name}`, `${ms * factor}ms`);
  }
  root.style.setProperty("--sb-slow", String(factor));
}

/** Simulates prefers-reduced-motion: the movement multiplier drops to 0, fades stay. */
export function setReduced(reduced: boolean): void {
  const root = document.documentElement;
  if (reduced) root.style.setProperty("--sb-move", "0");
  else root.style.removeProperty("--sb-move");
}
