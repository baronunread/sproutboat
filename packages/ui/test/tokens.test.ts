import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "../tokens/color";
import * as generated from "../src/tokens.generated";
import { applyDocRegions, renderThemeCss } from "../tokens/generate";
import { minRatio, pairs } from "../tokens/pairs";
import { colorNames, dark, light } from "../tokens/tokens";

const root = join(import.meta.dir, "..");
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
      for (const n of ["warn-fg", "warn-dot", "warn-soft", "warn-edge"] as const) {
        const hue = Number(/oklch\([\d.]+ [\d.]+ ([\d.]+)/.exec(theme[n])?.[1]);
        expect(hue).toBeGreaterThanOrEqual(60);
        expect(hue).toBeLessThanOrEqual(100);
      }
    }
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
