import { test, expect } from "@playwright/test";

/**
 * E2E tests for portal navigation search.
 *
 * The default auth state (a-12, NSM) lands in the employee portal.
 * The employee portal has an inline search input in the topbar — NOT
 * the admin AppShell command palette dialog (which is only for admin roles).
 *
 * Covers:
 * - Search input is visible in the topbar
 * - Typing into search opens a results listbox
 * - Results filter to match the search term
 * - Escape closes the search dropdown
 *
 * Run with:  npx playwright test tests/e2e/command-palette.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals";

test.describe("Portal navigation search", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.locator("h1").first().waitFor({ timeout: 30_000 });
  });

  test("search input is visible in the topbar", async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search"]');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute("placeholder", /Search portal pages/i);
  });

  test("typing into search opens results dropdown", async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search"]');
    await searchInput.fill("vacation");
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    await expect(listbox.locator('[role="option"]').first()).toBeVisible();
  });

  test("results filter to match the search term", async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search"]');
    await searchInput.fill("vacation");
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    await expect(listbox.getByText(/vacation/i).first()).toBeVisible();
  });

  test("Escape closes the search dropdown", async ({ page }) => {
    const searchInput = page.locator('input[aria-label="Search"]');
    await searchInput.fill("vacation");
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
  });
});
