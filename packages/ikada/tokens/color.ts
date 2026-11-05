/** OKLCH parsing and WCAG contrast. Pure, no dependencies. */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/;

function linearFromOklch(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    g: -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    b: -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Linear-light sRGB, gamut-clamped, for an opaque `oklch(...)` string. */
export function parseOklch(css: string): Rgb {
  const m = OKLCH.exec(css.trim());
  if (!m) throw new Error(`Not an oklch() color: ${css}`);
  const raw = linearFromOklch(Number(m[1]), Number(m[2]), Number(m[3]));
  return { r: clamp01(raw.r), g: clamp01(raw.g), b: clamp01(raw.b) };
}

export function luminance(css: string): number {
  const { r, g, b } = parseOklch(css);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two opaque colors. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
