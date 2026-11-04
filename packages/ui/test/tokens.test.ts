import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "../tokens/color";
import * as generated from "../src/tokens.generated";
import { applyDocRegions, renderThemeCss } from "../tokens/generate";
import { minRatio, pairs } from "../tokens/pairs";
import { colorNames, dark, light } from "../tokens/tokens";

const root = join(import.meta.dir, "..");
const oklchParts = (css: string): [number, number, number] => {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(css);
  return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
};
const hueOf = (css: string): number => oklchParts(css)[2];
const themes = { dark, light };
// Formatting (oxfmt) may re-space generated files; compare content only.
const strip = (s: string): string =>
  s
    .replace(/\s+/g, "")
    .replace(/-{3,}/g, "---")
    .replace(/,([)\]}])/g, "$1");

describe("contrast", () => {
  test("WCAG math matches known values", () => {
    expect(contrast("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 1);
    expect(contrast("oklch(0.5 0 0)", "oklch(0.5 0 0)")).toBe(1);
  });

  for (const [name, theme] of Object.entries(themes)) {
    for (const p of pairs) {
      const need = minRatio[p.kind];
      test(`${name}: ${p.fg} on ${p.bg} >= ${need}:1 (${p.kind}, ${p.note})`, () => {
        expect(contrast(theme[p.fg], theme[p.bg])).toBeGreaterThanOrEqual(need);
      });
    }
  }

  test("both themes define every token", () => {
    for (const n of colorNames) {
      expect(dark[n]).toBeTruthy();
      expect(light[n]).toBeTruthy();
    }
  });

  test("amber is never red: warn hue stays between 60 and 100 degrees", () => {
    for (const theme of [dark, light]) {
      for (const n of ["warn-fg", "warn-dot", "warn-soft", "chart-4xx"] as const) {
        expect(hueOf(theme[n])).toBeGreaterThanOrEqual(60);
        expect(hueOf(theme[n])).toBeLessThanOrEqual(100);
      }
    }
  });

  test("danger and the 5xx and error marks are red, never amber", () => {
    for (const theme of [dark, light]) {
      for (const n of ["danger", "danger-fg", "danger-dot", "chart-errors", "chart-5xx"] as const) {
        expect(hueOf(theme[n])).toBeGreaterThanOrEqual(15);
        expect(hueOf(theme[n])).toBeLessThanOrEqual(35);
      }
    }
  });

  test("green is only success, primary actions and focus: other colors stay 45+ degrees from hue 150", () => {
    const greens = new Set<string>([
      "brand",
      "brand-hover",
      "on-brand",
      "brand-fg",
      "brand-soft",
      "brand-dot",
      "focus",
    ]);
    greens.add("chart-2xx").add("diff-add");
    for (const theme of [dark, light]) {
      for (const n of colorNames) {
        if (greens.has(n) || n === "scrim") continue;
        const [, c] = oklchParts(theme[n]);
        if (c < 0.03) continue; // neutral greys carry no hue
        const gap = Math.abs(((hueOf(theme[n]) - 150 + 540) % 360) - 180);
        expect(gap, `${n} hue ${hueOf(theme[n])}`).toBeGreaterThanOrEqual(45);
      }
    }
  });

  test("light surfaces are neutral (chroma near zero) and dark surfaces are cool slate", () => {
    for (const n of ["canvas", "surface", "well", "hover", "raised", "hairline"] as const) {
      expect(oklchParts(light[n])[1]).toBeLessThan(0.004);
      const [, c, h] = oklchParts(dark[n]);
      expect(c).toBeGreaterThan(0.01);
      expect(h).toBeGreaterThanOrEqual(250);
      expect(h).toBeLessThanOrEqual(260);
    }
  });

  test("dark accent buttons are quieter than the v3 sheet (#67d283: L 0.78, C 0.15)", () => {
    const [l, c] = oklchParts(dark.brand);
    expect(l).toBeLessThan(0.78);
    expect(c).toBeLessThan(0.15);
  });

  test("every chart token exists in both themes and chart marks are covered by a contrast pair", () => {
    const chart: string[] = colorNames.filter((n) => n.startsWith("chart-"));
    const required: string[] = [
      "chart-requests",
      "chart-errors",
      "chart-deploy",
      "chart-2xx",
      "chart-3xx",
      "chart-4xx",
      "chart-5xx",
    ];
    for (const n of required) expect(chart).toContain(n);
    const paired = new Set<string>(pairs.map((p) => p.fg));
    for (const n of chart) if (n !== "chart-grid") expect(paired.has(n), n).toBe(true);
  });
});

describe("generated files are current", () => {
  test("theme.css", () => {
    expect(strip(readFileSync(join(root, "src/theme.css"), "utf8"))).toBe(strip(renderThemeCss()));
  });
  test("tokens.generated.ts", () => {
    expect([...generated.colorNames]).toEqual([...colorNames]);
    for (const n of colorNames) {
      expect(`${generated.colors.dark[n]}`).toBe(`${dark[n]}`);
      expect(`${generated.colors.light[n]}`).toBe(`${light[n]}`);
    }
  });
  test("DESIGN.md tables", () => {
    const doc = readFileSync(join(root, "DESIGN.md"), "utf8");
    expect(strip(doc)).toBe(strip(applyDocRegions(doc)));
  });
});
