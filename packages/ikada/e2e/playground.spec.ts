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

// The app batch: Avatar, SegmentedControl, RadioGroup, SensitiveInput, DescriptionList, Pagination, CodeBlock
// and the router link adapter. Captured on its own so a layout change there is easy to review.
for (const width of widths) {
  for (const theme of themes) {
    test(`app pieces ${theme} ${width}px: no overflow, reveal works`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?view=${theme}`);
      const section = page
        .locator("section")
        .filter({ has: page.locator('[data-section="Account and app pieces"]') })
        .last();
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole("heading", { name: "Account and app pieces" })).toBeVisible();
      const password = section.getByLabel("Password", { exact: true });
      await expect(password).toHaveAttribute("type", "password");
      await section.getByRole("button", { name: "Show value" }).first().click();
      await expect(password).toHaveAttribute("type", "text");
      await section.getByRole("button", { name: "Next page" }).first().click();
      await expect(section.getByRole("button", { name: "Page 7" }).first()).toHaveAttribute("aria-current", "page");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      await section.screenshot({ path: info.outputPath(`app-pieces-${theme}-${width}.png`) });
    });
  }
}
