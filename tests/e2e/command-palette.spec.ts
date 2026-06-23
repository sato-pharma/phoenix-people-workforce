import { test, expect } from "@playwright/test";

/**
 * E2E tests for the global Command Palette (Ctrl/⌘-K).
 *
 * The palette is mounted in the shared AppShell, so it is available in both the
 * admin surface and the employee portal. The default auth state signs in as an
 * NSM who lands in the employee portal, so these tests exercise it there.
 *
 * Covers:
 * - Opens via Ctrl/⌘-K, input is focused
 * - Lists permission-gated navigation destinations
 * - Filters as you type
 * - Escape closes it
 * - Opens via the top search button
 *
 * Run with:  npx playwright test tests/e2e/command-palette.spec.ts
 *
 * NOTE: A data-health `?view=` deep-link test belongs here too, but it requires
 * an admin-authenticated project (the default NSM cannot open /admin/data-health).
 * Track that as a follow-up once an admin storageState project exists.
 */

const BASE_URL = "http://localhost:3000/employee-portals";

test.describe("Command palette", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  });

  test("opens with Ctrl/Cmd+K, focuses input, filters, and closes on Escape", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const input = dialog.getByPlaceholder(/jump to a page or module/i);
    await expect(input).toBeFocused();

    // Lists at least one navigation destination the signed-in user can open.
    await expect(dialog.getByRole("listitem").first()).toBeVisible();

    // Filtering narrows the list.
    await input.fill("vacation");
    await expect(dialog.getByText(/vacation/i).first()).toBeVisible();

    // Escape closes it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("opens via the top search button", async ({ page }) => {
    await page.getByRole("button", { name: /open command palette/i }).first().click();
    await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible({ timeout: 10_000 });
  });
});
