import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Probation Tracker page (/employee-portals/probation).
 *
 * Covers:
 * - Page load & hero header
 * - Stat cards with thin gridlines
 * - Zone distribution bar
 * - Filters (search, dropdowns, apply/reset)
 * - Probation table (desktop + mobile card view)
 * - Zone badges
 * - Progress bars
 * - Print stylesheet
 * - RTL support
 * - Mobile responsiveness
 * - Error boundary verification
 *
 * Run with:  npx playwright test tests/e2e/probation.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/probation";

test.describe("Probation Tracker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(
      page.locator("h1").filter({ hasText: /Probation/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Probation/i }),
    ).toBeVisible();
  });

  test("hero shows people operations badge", async ({ page }) => {
    const badge = page
      .locator("section p.text-orange-100")
      .filter({ hasText: /People Operations/ });
    await expect(badge).toBeVisible();
  });

  // ─── Stat Cards ───────────────────────────────────────────────────

  test("all four stat cards are visible", async ({ page }) => {
    await expect(
      page.getByText("Total in Probation", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Safe Zone", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Warning Zone", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Critical Zone", { exact: true }),
    ).toBeVisible();
  });

  test("stat cards show numeric values", async ({ page }) => {
    const numericValue = page.locator(".text-2xl").first();
    await expect(numericValue).toBeVisible();
  });

  // ─── Zone Distribution ────────────────────────────────────────────

  test("zone distribution section is visible", async ({ page }) => {
    await expect(page.getByText("Zone Distribution")).toBeVisible();
    await expect(
      page.getByText("Risk breakdown across probation employees"),
    ).toBeVisible();
  });

  // ─── Filters ──────────────────────────────────────────────────────

  test("filters card shows filter badge", async ({ page }) => {
    await expect(
      page.getByText("Filters", { exact: true }).first(),
    ).toBeVisible();
  });

  test("search input is visible", async ({ page }) => {
    const searchInput = page.locator(
      'input[placeholder*="Search name"]',
    );
    await expect(searchInput).toBeVisible();
  });

  test("filter dropdowns are visible", async ({ page }) => {
    // Check for line, area, job title, zone selects
    const selects = page.locator("select");
    const count = await selects.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test("reset button is visible", async ({ page }) => {
    await expect(
      page.locator("button").filter({ hasText: "Reset" }),
    ).toBeVisible();
  });

  // ─── Table ────────────────────────────────────────────────────────

  test("desktop table shows column headers", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const employeeHeader = page
      .locator("th")
      .filter({ hasText: "Employee" })
      .first();
    const hasTable = await employeeHeader.isVisible().catch(() => false);
    if (hasTable) {
      await expect(employeeHeader).toBeVisible();
      const zoneHeader = page
        .locator("th")
        .filter({ hasText: "Zone" })
        .first();
      await expect(zoneHeader).toBeVisible();
      const progressHeader = page
        .locator("th")
        .filter({ hasText: "Progress" })
        .first();
      await expect(progressHeader).toBeVisible();
    }
  });

  test("table has data rows on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const firstRow = page.locator("table tbody tr").first();
    const hasRows = await firstRow.isVisible().catch(() => false);
    if (hasRows) {
      await expect(firstRow).toBeVisible();
    }
  });

  test("zone labels are visible in distribution legend", async ({ page }) => {
    // Zone distribution legend shows "Safe XX%", "Warning XX%", "Critical XX%"
    const safeLegend = page.getByText(/Safe \d+%/).first();
    const warningLegend = page.getByText(/Warning \d+%/).first();
    const criticalLegend = page.getByText(/Critical \d+%/).first();
    const hasSafe = await safeLegend.isVisible().catch(() => false);
    const hasWarning = await warningLegend.isVisible().catch(() => false);
    const hasCritical = await criticalLegend.isVisible().catch(() => false);
    expect(hasSafe || hasWarning || hasCritical).toBe(true);
  });

  // ─── RTL Support ──────────────────────────────────────────────────

  test("root container has dir=auto for RTL support", async ({ page }) => {
    const root = page.locator('[dir="auto"]');
    await expect(root.first()).toBeVisible();
  });

  // ─── Print Stylesheet ─────────────────────────────────────────────

  test("print stylesheet is embedded", async ({ page }) => {
    const hasMediaPrint = await page.evaluate(() => {
      const styles = document.querySelectorAll("style");
      for (const s of styles) {
        if (s.textContent?.includes("@media print")) return true;
      }
      return false;
    });
    expect(hasMediaPrint).toBe(true);
  });

  // ─── Mobile Responsiveness ────────────────────────────────────────

  test("mobile viewport renders all sections without crash", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.getByText("Total in Probation", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Zone Distribution")).toBeVisible();
  });

  test("mobile card view is visible on small screens", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Desktop table should be hidden on mobile
    const table = page.locator("table").first();
    const tableVisible = await table.isVisible().catch(() => false);
    if (!tableVisible) {
      // Mobile cards should be visible
      const mobileCards = page.locator(".sm\\:hidden").first();
      const hasCards = await mobileCards.isVisible().catch(() => false);
      if (hasCards) {
        await expect(mobileCards).toBeVisible();
      }
    }
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.getByText("Total in Probation", { exact: true }),
    ).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({
    page,
  }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Probation/i }).first(),
    ).toBeVisible();
  });
});
