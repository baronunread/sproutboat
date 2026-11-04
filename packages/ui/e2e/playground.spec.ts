import { expect, test } from "@playwright/test";

const widths = [390, 1440];
const themes = ["light", "dark"];
const opens = ["menu", "select", "dialog", "tooltip", "popover", "toast"];

// Screenshots are written to test-results for review rather than compared with
// stored baselines: font rasterisation differs between macOS and the CI image,
// so pixel baselines would fail on one of them. The hard assertions are layout
// ones (no horizontal overflow) and that every open state actually opens.
for (const width of widths) {
  for (const theme of themes) {
    test(`playground ${theme} ${width}px has no overflow`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?view=${theme}`);
      await expect(page.getByRole("heading", { name: "Button", exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      await page.screenshot({ path: info.outputPath(`page-${theme}-${width}.png`), fullPage: true });
    });

    test(`open states ${theme} ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const roles = new Map<string, "menu" | "listbox" | "dialog">([
        ["menu", "menu"],
        ["select", "listbox"],
        ["dialog", "dialog"],
        ["popover", "dialog"],
      ]);
      for (const open of opens) {
        await page.goto(`/?view=${theme}&open=${open}`);
        const role = roles.get(open);
        if (role) await expect(page.getByRole(role).first()).toBeVisible();
        else
          await expect(
            page.getByText(open === "tooltip" ? "Copies the deployment ID" : "Deployment ready").first(),
          ).toBeVisible();
        await page.screenshot({ path: info.outputPath(`open-${open}-${theme}-${width}.png`) });
      }
    });
  }
}

test("keyboard focus shows a visible ring", async ({ page }) => {
  await page.goto("/?view=light");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineWidth : "";
  });
  expect(outline).toBe("solid 2px");
});
