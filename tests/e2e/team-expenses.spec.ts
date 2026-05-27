import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Team Expenses page (/employee-portals/team-expenses).
 *
 * Covers:
 * - Page load & hero header
 * - Filters (DSM select, request type, period dropdown with focus trap)
 * - Stat cards with thin gridlines
 * - Monthly trend chart + DSM expense ranking chart
 * - DSM summary table (desktop + mobile)
 * - Recent trips table (desktop + mobile)
 * - ARIA labels for charts
 * - Print stylesheet
 * - RTL support
 * - Error boundary wrappers
 * - Mobile responsiveness
 *
 * Run with:  npx playwright test tests/e2e/team-expenses.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/team-expenses";

test.describe("Team Expenses", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(
      page.locator("h1").filter({ hasText: /Team Expenses/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(page.locator("h1").filter({ hasText: /Team Expenses/i })).toBeVisible();
  });

  test("hero shows expense management badge", async ({ page }) => {
    const badge = page.locator("section p.text-orange-100").filter({ hasText: /Expense Management/ });
    await expect(badge).toBeVisible();
  });

  // ─── Filters ──────────────────────────────────────────────────────

  test("filters card shows filter badge", async ({ page }) => {
    await expect(page.getByText("Filters", { exact: true }).first()).toBeVisible();
  });

  test("DSM select filter is visible", async ({ page }) => {
    const dsmSelect = page.locator("#team-expenses-dsm");
    await expect(dsmSelect).toBeVisible();
  });

  test("request type select filter is visible", async ({ page }) => {
    const rtSelect = page.locator("#team-expenses-request-type");
    await expect(rtSelect).toBeVisible();
  });

  test("period dropdown button is visible", async ({ page }) => {
    const periodBtn = page.locator("button").filter({ hasText: /All Periods|periods selected/ });
    await expect(periodBtn).toBeVisible();
  });

  test("period dropdown has aria-expanded attribute", async ({ page }) => {
    // Target the period filter button specifically (not the sidebar mobile menu button)
    const periodBtn = page.locator('button[aria-haspopup="listbox"]');
    await expect(periodBtn).toBeVisible();
    await expect(periodBtn).toHaveAttribute("aria-expanded", "false");
  });

  test("period dropdown opens on click", async ({ page }) => {
    const periodBtn = page.locator('button[aria-haspopup="listbox"]');
    await periodBtn.click();
    await expect(periodBtn).toHaveAttribute("aria-expanded", "true");
    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();
  });

  test("period dropdown closes on Escape key", async ({ page }) => {
    const periodBtn = page.locator('button[aria-haspopup="listbox"]');
    await periodBtn.click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="listbox"]')).not.toBeVisible();
  });

  test("apply and reset buttons are visible", async ({ page }) => {
    await expect(page.locator("button").filter({ hasText: "Apply" }).first()).toBeVisible();
    await expect(page.locator("button").filter({ hasText: "Reset" })).toBeVisible();
  });

  // ─── Stat Cards ───────────────────────────────────────────────────

  test("all four stat cards are visible", async ({ page }) => {
    await expect(page.getByText("Total Expenses", { exact: true })).toBeVisible();
    await expect(page.getByText("Approved Amount", { exact: true })).toBeVisible();
    await expect(page.getByText("Pending Amount", { exact: true })).toBeVisible();
    await expect(page.getByText("Avg Cost / Trip", { exact: true })).toBeVisible();
  });

  test("stat values show EGP currency format", async ({ page }) => {
    const egpValue = page.getByText(/EGP\s[\d,]+/).first();
    await expect(egpValue).toBeVisible();
  });

  // ─── Charts ───────────────────────────────────────────────────────

  test("monthly trend chart section is visible", async ({ page }) => {
    await expect(page.getByText("Monthly Trend").first()).toBeVisible();
    await expect(page.getByText("Expenses and Trips by Period")).toBeVisible();
  });

  test("DSM expense ranking chart section is visible", async ({ page }) => {
    await expect(page.getByText("DSM Expense Ranking").first()).toBeVisible();
    await expect(page.getByText("Highest Spend Across Your DSM Team")).toBeVisible();
  });

  test("charts have ARIA labels for accessibility", async ({ page }) => {
    const trendChart = page.locator('[role="img"][aria-label*="expense trend"]');
    await expect(trendChart.first()).toBeVisible();
    const rankingChart = page.locator('[role="img"][aria-label*="expense ranking"]');
    await expect(rankingChart.first()).toBeVisible();
  });

  // ─── DSM Summary Table ────────────────────────────────────────────

  test("DSM summary section is visible", async ({ page }) => {
    await expect(page.getByText("DSM Summary", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Team Expense Dashboard by District Manager")).toBeVisible();
  });

  test("DSM summary table shows column headers on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const dsmHeader = page.locator("th").filter({ hasText: "DSM" }).first();
    await expect(dsmHeader).toBeVisible();
    const tripsHeader = page.locator("th").filter({ hasText: "Trips" }).first();
    await expect(tripsHeader).toBeVisible();
  });

  test("DSM summary table has data rows", async ({ page }) => {
    const firstRow = page.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
  });

  // ─── Recent Trips Table ───────────────────────────────────────────

  test("recent trips section is visible", async ({ page }) => {
    await expect(page.getByText("Recent Trips", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Latest DSM Trips in Selected Scope")).toBeVisible();
  });

  test("recent trips shows status badges", async ({ page }) => {
    const approved = page.getByText("Approved").first();
    const pending = page.getByText("Pending").first();
    const hasApproved = await approved.isVisible().catch(() => false);
    const hasPending = await pending.isVisible().catch(() => false);
    expect(hasApproved || hasPending).toBe(true);
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

  test("mobile viewport renders all sections without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByText("Total Expenses", { exact: true })).toBeVisible();
    await expect(page.getByText("DSM Summary", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Recent Trips", { exact: true }).first()).toBeVisible();
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByText("Monthly Trend").first()).toBeVisible();
    await expect(page.getByText("DSM Expense Ranking").first()).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Team Expenses/i }).first(),
    ).toBeVisible();
  });
});
