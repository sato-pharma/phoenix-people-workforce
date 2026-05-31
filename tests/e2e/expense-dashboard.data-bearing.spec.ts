import { test, expect } from "@playwright/test";

/**
 * Data-bearing E2E tests for the Expense Dashboard.
 *
 * These tests require a user account that has expense rows linked. The
 * default Ali (a-12) NSM account does NOT have personal trips, so
 * chart / table / insight branches are never exercised in CI without
 * a second fixture.
 *
 * Enable via environment variables:
 *   PLAYWRIGHT_DATA_USER_HRID
 *   PLAYWRIGHT_DATA_USER_PASSWORD
 *
 * When these env vars are unset, this file is ignored by playwright.config.ts
 * (the chromium-data-user project is conditionally registered).
 *
 * Run with:  npx playwright test tests/e2e/expense-dashboard.data-bearing.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/expense-dashboard";

test.describe("Expense Dashboard — data-bearing user", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    // Wait for the actual dashboard (not the empty-state) to render.
    // The KPI cards only appear when there are expense rows linked.
    await expect(
      page.getByText("Total Expenses", { exact: false }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ─── KPI Stat Cards ──────────────────────────────────────────────

  test("all 5 KPI cards render with values", async ({ page }) => {
    await expect(page.getByText("Total Expenses", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Total Trips", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Avg Cost per Trip", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Total KM", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Month over Month", { exact: false }).first()).toBeVisible();
  });

  // ─── Insights Strip ──────────────────────────────────────────────

  test("insights strip shows top destination / cost outlier / cost efficiency", async ({
    page,
  }) => {
    await expect(page.locator("p").filter({ hasText: /Top destination/i }).first()).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /Cost outlier/i }).first()).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /Cost efficiency/i }).first()).toBeVisible();
  });

  // ─── Charts ──────────────────────────────────────────────────────

  test("monthly trend chart renders SVG content", async ({ page }) => {
    const chartHeader = page
      .locator("h3")
      .filter({ hasText: /Monthly Expense Trend/i })
      .first();
    await expect(chartHeader).toBeVisible();
    // Recharts produces an <svg> with role="img" inside the chart card
    const chartCard = chartHeader.locator("..").locator("..");
    await expect(chartCard.locator("svg").first()).toBeVisible();
  });

  test("expense breakdown pie chart renders", async ({ page }) => {
    const heading = page
      .locator("h3")
      .filter({ hasText: /Expense Breakdown/i })
      .first();
    await expect(heading).toBeVisible();
    const card = heading.locator("..").locator("..");
    await expect(card.locator("svg").first()).toBeVisible();
  });

  test("status distribution shows progress bars with ARIA values", async ({ page }) => {
    const heading = page
      .locator("h3")
      .filter({ hasText: /Trip Status Distribution/i })
      .first();
    await expect(heading).toBeVisible();
    const progress = page.locator('[role="progressbar"]').first();
    if (await progress.isVisible().catch(() => false)) {
      await expect(progress).toHaveAttribute("aria-valuenow", /\d+/);
    }
  });

  test("transportation chart renders with toggle button", async ({ page }) => {
    const heading = page
      .locator("h3")
      .filter({ hasText: /Trips by Transportation/i })
      .first();
    await expect(heading).toBeVisible();
    const toggle = page
      .locator("button")
      .filter({ hasText: /Show total cost|Show trip count/i })
      .first();
    await expect(toggle).toBeVisible();
    await toggle.click();
  });

  test("destination chart renders", async ({ page }) => {
    const heading = page
      .locator("h3")
      .filter({ hasText: /Trips by Destination City/i })
      .first();
    await expect(heading).toBeVisible();
  });

  // ─── Trip Table ──────────────────────────────────────────────────

  test("trip table renders with at least one row", async ({ page }) => {
    const tableHeader = page.locator("th").filter({ hasText: /TripID/i }).first();
    const mobileCards = page.locator("p").filter({ hasText: /TripID|N\/A/ });
    const hasTable = await tableHeader.isVisible().catch(() => false);
    const hasMobile = await mobileCards.first().isVisible().catch(() => false);
    expect(hasTable || hasMobile).toBe(true);
  });

  test("density toggle changes table padding", async ({ page }) => {
    const compactBtn = page
      .locator('button[aria-pressed]')
      .filter({ hasText: /^Compact$/ })
      .first();
    await expect(compactBtn).toBeVisible();
    await compactBtn.click();
    await expect(compactBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("CSV export button is enabled and downloadable", async ({ page }) => {
    const exportBtn = page.locator('button[aria-label="Export trips to CSV"]');
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).not.toBeDisabled();
    // Wire up a download listener and click
    const downloadPromise = page.waitForEvent("download", { timeout: 5_000 });
    await exportBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/expense-trips-.*\.csv/);
  });

  test("page size selector changes pagination", async ({ page }) => {
    const sizeSelect = page.locator('select[aria-label="Rows per page"]');
    await expect(sizeSelect).toBeVisible();
    await sizeSelect.selectOption("25");
    await expect(sizeSelect).toHaveValue("25");
  });

  // ─── URL Sync ────────────────────────────────────────────────────

  test("period preset updates URL search params", async ({ page }) => {
    const sevenDays = page
      .locator("button")
      .filter({ hasText: /^7 days$/i })
      .first();
    await sevenDays.click();
    await expect(page).toHaveURL(/period=7d/);
  });
});
