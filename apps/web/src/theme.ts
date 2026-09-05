/**
 * Theme resolution, in the two forms it has to exist in.
 *
 * `THEME_BOOT` runs as a string in <head>, before this bundle exists, because
 * the painted theme has to be on <html> before the first paint or the page
 * flashes the wrong one. `resolveTheme` is the same rule for the running app,
 * where the reader changes the preference from the account menu.
 *
 * Two copies of one rule is a drift risk, which is what theme.test.ts is for:
 * it runs the boot script against a stub document and asserts it agrees with
 * this function for every preference, and that the OS listener it registers
 * repaints. Nothing here touches the DOM at import time, so the test needs no
 * browser.
 */
export type Theme = "dark" | "light" | "system";

/** What gets stamped on data-theme: always a real theme, never "system". */
export function resolveTheme(pref: Theme, prefersLight: boolean): "dark" | "light" {
  if (pref === "system") return prefersLight ? "light" : "dark";
  return pref;
}

/**
 * Two attributes, because the choice and the painted theme stop being the same
 * thing once "system" exists: data-theme is what the CSS keys off and is
 * always light or dark, data-theme-pref is what the reader picked.
 *
 * Nothing stored means "system": a reader who has never touched the control
 * gets the theme their machine asks for. The prerendered shell still paints
 * dark before the boot script runs — no data-theme attribute is the dark
 * branch of the CSS — so a light-OS reader's first paint is corrected here,
 * before it reaches the screen, rather than flashing after hydration.
 */
export const THEME_BOOT = `
(function () {
  var media = matchMedia('(prefers-color-scheme: light)');
  var paint = function () {
    var pref = localStorage.getItem('sproutboat-theme') || 'system';
    document.documentElement.dataset.themePref = pref;
    document.documentElement.dataset.theme =
      pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
  };
  paint();
  // Follows the OS while it is being followed: a reader on 'system' who flips
  // their machine to light mid-session should not have to reload.
  media.addEventListener('change', paint);
})();
`;
