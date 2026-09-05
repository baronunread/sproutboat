import { describe, expect, test } from "bun:test";
import { THEME_BOOT, resolveTheme, type Theme } from "./theme";

/**
 * Runs THEME_BOOT against the smallest stubs it touches. The point is drift:
 * the boot script cannot import resolveTheme (it runs before the bundle), so
 * the rule exists twice and nothing but this test keeps the copies honest.
 */
function boot(stored: string | null, prefersLight: boolean) {
  const dataset: Record<string, string> = {};
  const listeners: Array<() => void> = [];
  const media = {
    matches: prefersLight,
    addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
  };
  const scope = {
    matchMedia: () => media,
    localStorage: { getItem: () => stored },
    document: { documentElement: { dataset } },
  };
  new Function("matchMedia", "localStorage", "document", THEME_BOOT)(
    scope.matchMedia,
    scope.localStorage,
    scope.document,
  );
  /** Flip the emulated OS setting and fire what the browser would fire. */
  const flipOS = (nowPrefersLight: boolean) => {
    media.matches = nowPrefersLight;
    for (const listener of listeners) listener();
  };
  return { dataset, flipOS, listenerCount: () => listeners.length };
}

describe("theme boot", () => {
  test("paints the stored preference, and records it separately", () => {
    for (const pref of ["dark", "light"] as const) {
      const { dataset } = boot(pref, false);
      expect(dataset.theme).toBe(pref);
      expect(dataset.themePref).toBe(pref);
    }
  });

  test("nothing stored follows the OS", () => {
    expect(boot(null, true).dataset.theme).toBe("light");
    expect(boot(null, false).dataset.theme).toBe("dark");
    expect(boot(null, true).dataset.themePref).toBe("system");
  });

  test("a reader with nothing stored still tracks the OS changing", () => {
    const { dataset, flipOS } = boot(null, false);
    expect(dataset.theme).toBe("dark");
    flipOS(true);
    expect(dataset.theme).toBe("light");
  });

  test("system resolves against prefers-color-scheme", () => {
    expect(boot("system", true).dataset.theme).toBe("light");
    expect(boot("system", false).dataset.theme).toBe("dark");
  });

  test("system repaints when the OS setting changes, without a reload", () => {
    const { dataset, flipOS } = boot("system", false);
    expect(dataset.theme).toBe("dark");
    flipOS(true);
    expect(dataset.theme).toBe("light");
    expect(dataset.themePref).toBe("system");
  });

  test("an explicit choice ignores the OS setting changing under it", () => {
    const { dataset, flipOS } = boot("dark", false);
    flipOS(true);
    expect(dataset.theme).toBe("dark");
  });

  test("agrees with resolveTheme for every preference", () => {
    for (const pref of ["dark", "light", "system"] as const satisfies readonly Theme[]) {
      for (const prefersLight of [true, false]) {
        expect(boot(pref, prefersLight).dataset.theme).toBe(resolveTheme(pref, prefersLight));
      }
    }
  });
});
