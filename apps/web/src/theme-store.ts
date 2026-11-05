import { resolveTheme, type Theme } from "./theme";

/**
 * The running app's half of what the boot script does before first paint. Both stamp the
 * same two attributes on <html> and use the same `sproutboat-theme` key; theme.ts holds the
 * shared rule and the test that keeps the boot script's inlined copy of it honest.
 *
 * React needs the preference, not the painted theme, so a menu can name the state it is in.
 * It is read from the attribute during render (an effect would paint the first frame with the
 * wrong choice), and subscribed through a MutationObserver so a change made anywhere, the
 * settings page included, reaches every reader.
 */
export function subscribeTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-pref"] });
  return () => observer.disconnect();
}

export function themePref(): Theme {
  const pref = document.documentElement.dataset.themePref;
  return pref === "light" || pref === "dark" ? pref : "system";
}

/** The prerendered shell is built with no reader, so it renders the default. */
export function themePrefOnServer(): Theme {
  return "system";
}

export function setTheme(pref: Theme): void {
  localStorage.setItem("sproutboat-theme", pref);
  document.documentElement.dataset.themePref = pref;
  document.documentElement.dataset.theme = resolveTheme(pref, matchMedia("(prefers-color-scheme: light)").matches);
}

export const isTheme = (value: string): value is Theme => value === "system" || value === "light" || value === "dark";
