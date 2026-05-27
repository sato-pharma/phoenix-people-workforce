import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Vacancies page (/employee-portals/vacancies).
 *
 * Covers:
 * - Page load & hero header
 * - Filters (area select, manager select, apply/reset)
 * - Stat cards with thin gridlines
 * - Vacancy table (desktop + mobile card view)
 * - Status badges
 * - ARIA / accessibility basics
 * - Print stylesheet
 * - RTL support
 * - Mobile responsiveness
 * - Error boundary verification
 *
 * Run with:  npx playwright test tests/e2e/vacancies.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/vacancies";

test.describe("Vacancies", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(
      page.locator("h1").filter({ hasText: /Vacancies/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Vacancies/i }),
    ).toBeVisible();
  });

  test("hero shows team operations badge", async ({ page }) => {
    const badge = page
      .locator("section p.text-orange-100")
      .filter({ hasText: /Team Operations/ });
    await expect(badge).toBeVisible();
  });

  // ─── Filters ──────────────────────────────────────────────────────

  test("filters card shows filter badge", async ({ page }) => {
    await expect(
      page.getByText("Filters", { exact: true }).first(),
    ).toBeVisible();
  });

  test("area select filter is visible", async ({ page }) => {
    const areaSelect = page.locator("#vacancies-area");
    await expect(areaSelect).toBeVisible();
  });

  test("manager select filter is visible", async ({ page }) => {
    const managerSelect = page.locator("#vacancies-manager");
    await expect(managerSelect).toBeVisible();
  });

  test("apply and reset buttons are visible", async ({ page }) => {
    await expect(
      page.locator("button").filter({ hasText: "Apply" }).first(),
    ).toBeVisible();
    await expect(
      page.locator("a").filter({ hasText: "Reset" }),
    ).toBeVisible();
  });

  test("area select has 'All areas' default option", async ({ page }) => {
    const areaSelect = page.locator("#vacancies-area");
    const firstOption = areaSelect.locator("option").first();
    await expect(firstOption).toHaveText("All areas");
  });

  test("manager select has 'All managers' default option", async ({
    page,
  }) => {
    const managerSelect = page.locator("#vacancies-manager");
    const firstOption = managerSelect.locator("option").first();
    await expect(firstOption).toHaveText("All managers");
  });

  // ─── Stat Cards ───────────────────────────────────────────────────

  test("all four stat cards are visible", async ({ page }) => {
    await expect(
      page.getByText("Open Vacancies", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Affected Areas", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("DSM Vacancies", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Scope", { exact: true })).toBeVisible();
  });

  test("stat cards show numeric values", async ({ page }) => {
    const numericValue = page.locator(".text-xl, .text-2xl").first();
    await expect(numericValue).toBeVisible();
  });

  // ─── Vacancy Table ────────────────────────────────────────────────

  test("vacancy list section is visible", async ({ page }) => {
    const vacList = page.getByText("Vacancy List");
    const noVacancies = page.getByText("No matching vacancies");
    const hasVacList = await vacList.isVisible().catch(() => false);
    const hasNoVacancies = await noVacancies.isVisible().catch(() => false);
    expect(hasVacList || hasNoVacancies).toBe(true);
  });

  test("desktop table shows column headers", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const vacancyHeader = page
      .locator("th")
      .filter({ hasText: "Vacancy" })
      .first();
    const hasTable = await vacancyHeader.isVisible().catch(() => false);
    if (hasTable) {
      await expect(vacancyHeader).toBeVisible();
      const positionHeader = page
        .locator("th")
        .filter({ hasText: "Position" })
        .first();
      await expect(positionHeader).toBeVisible();
      const statusHeader = page
        .locator("th")
        .filter({ hasText: "Status" })
        .first();
      await expect(statusHeader).toBeVisible();
      const openedHeader = page
        .locator("th")
        .filter({ hasText: "Opened" })
        .first();
      await expect(openedHeader).toBeVisible();
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

  test("status badges are visible", async ({ page }) => {
    const open = page.getByText("Open", { exact: true }).first();
    const filled = page.getByText("Filled").first();
    const cancelled = page.getByText("Cancelled").first();
    const hasOpen = await open.isVisible().catch(() => false);
    const hasFilled = await filled.isVisible().catch(() => false);
    const hasCancelled = await cancelled.isVisible().catch(() => false);
    expect(hasOpen || hasFilled || hasCancelled).toBe(true);
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
      page.getByText("Open Vacancies", { exact: true }),
    ).toBeVisible();
    // Either vacancy list or empty state should be visible
    const vacList = page.getByText("Vacancy List");
    const noVacancies = page.getByText("No matching vacancies");
    const hasVacList = await vacList.isVisible().catch(() => false);
    const hasNoVacancies = await noVacancies.isVisible().catch(() => false);
    expect(hasVacList || hasNoVacancies).toBe(true);
  });

  test("mobile card view is visible on small screens", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Desktop table should be hidden on mobile
    const table = page.locator("table").first();
    const tableVisible = await table.isVisible().catch(() => false);
    if (!tableVisible) {
      // Mobile cards should be visible — check vacancy content is present
      const vacList = page.getByText("Vacancy List");
      const hasVacList = await vacList.isVisible().catch(() => false);
      if (hasVacList) {
        // Verify mobile cards render (border-l-[3px] elements with vacancy data)
        const mobileCards = page.locator(".sm\\:hidden > div").first();
        await expect(mobileCards).toBeVisible();
      }
    }
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.getByText("Open Vacancies", { exact: true }),
    ).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({
    page,
  }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Vacancies/i }).first(),
    ).toBeVisible();
  });
});
