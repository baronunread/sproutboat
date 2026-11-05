import { expect, test } from "@playwright/test";
import { authFile, gotoHydrated } from "./helpers";

test.use({ storageState: authFile("test-admin") });

const HOOK = "https://example.com/hook";

test("a private address is refused with the server's reason, inline", async ({ page }) => {
  await gotoHydrated(page, "/settings/webhooks");
  await page.getByRole("button", { name: "Add webhook" }).click();
  const dialog = page.getByRole("dialog", { name: /add webhook|webhook created/i });
  await dialog.getByRole("textbox", { name: "URL" }).fill("http://10.0.0.5/hook");
  await dialog.getByRole("button", { name: "Add webhook" }).click();
  await expect(dialog.getByText(/private or reserved address/i)).toBeVisible();
  await expect(dialog.getByLabel("Signing secret")).toHaveCount(0);
});

test("create, send a test, read the deliveries, delete", async ({ page }) => {
  await gotoHydrated(page, "/settings/webhooks");
  await expect(page.getByRole("heading", { name: "Webhooks", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Add webhook" }).click();
  const dialog = page.getByRole("dialog", { name: /add webhook|webhook created/i });
  await dialog.getByRole("textbox", { name: "URL" }).fill(HOOK);
  await dialog.getByRole("button", { name: "Add webhook" }).click();

  // The signing secret and the verification snippet appear once, right after creation.
  await expect(dialog.getByText("Webhook created")).toBeVisible();
  await expect(dialog.getByLabel("Signing secret")).toHaveValue(/.{16,}/);
  await expect(dialog.getByText(/x-sproutboat-signature/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("region", { name: "Webhooks" }).getByRole("row").filter({ hasText: HOOK });
  await expect(row).toBeVisible();
  await expect(row.getByRole("switch")).toBeChecked();

  // Reading it back never returns the secret.
  await page.reload();
  await expect(page.getByText("Signing secret")).toHaveCount(0);

  await row.getByRole("button", { name: /^send test/i }).click();
  await expect(page.getByText("Test event queued")).toBeVisible();

  // With no egress on the local stack the delivery is pending or failed: either is a row.
  await row.getByRole("button", { name: /^deliveries for/i }).click();
  const deliveriesDialog = page.getByRole("dialog", { name: "Deliveries" });
  const deliveries = deliveriesDialog.getByRole("region", { name: "Deliveries" }).locator("tbody tr");
  await expect(deliveries.first()).toContainText("webhook.test");
  await expect(deliveries.first()).toContainText(/pending|failed|refused|delivered/);
  await deliveriesDialog.getByRole("button", { name: "Close" }).click();

  await row.getByRole("button", { name: /^delete webhook/i }).click();
  await page
    .getByRole("dialog", { name: "Delete this webhook?" })
    .getByRole("button", { name: /delete webhook/i })
    .click();
  await expect(page.getByRole("region", { name: "Webhooks" }).getByRole("row").filter({ hasText: HOOK })).toHaveCount(
    0,
  );
});

test("the seeded webhook can be switched off and on", async ({ page }) => {
  await gotoHydrated(page, "/settings/webhooks");
  const row = page.getByRole("region", { name: "Webhooks" }).getByRole("row").filter({ hasText: "seed-hook" });
  const toggle = row.getByRole("switch");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toBeChecked();
});
