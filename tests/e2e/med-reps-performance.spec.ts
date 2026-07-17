import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Medical Reps Performance page (/employee-portals/med-reps-performance).
 *
 * Covers:
 * - Page load & hero header
 * - Line Snapshot card (stats, period filter)
 * - Achievement distribution bar
 * - Leaderboard table (desktop columns, mobile cards)
 * - District-Wise Performance section divider
 * - DSM group headers with achievement color indicators
 * - Charts (achievement ranking, sales vs target)
 * - Product breakdown section
 * - ARIA labels for charts
 * - Print stylesheet
 * - RTL support
 * - Error boundary wrappers
 * - Mobile responsiveness
 *
 * Run with:  pnpm exec playwright test tests/e2e/med-reps-performance.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/med-reps-performance";

test.describe("Medical Reps Performance", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(/Medical Reps Performance|Performance Data Unavailable/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(page.getByText("Medical Reps Performance").first()).toBeVisible();
  });

  test("hero shows team performance badge", async ({ page }) => {
    // The hero badge is inside the dark shell section with text-orange-100
    const badge = page.locator("section p.text-orange-100").filter({ hasText: /Team Performance/ });
    await expect(badge).toBeVisible();
  });

  // ─── Line Snapshot Card ───────────────────────────────────────────

  test("line snapshot card is visible", async ({ page }) => {
    await expect(page.getByText("Line Snapshot")).toBeVisible();
  });

  test("line snapshot shows line-wide performance badge", async ({ page }) => {
    await expect(page.getByText("Line-wide performance")).toBeVisible();
  });

  test("line achievement percentage is displayed", async ({ page }) => {
    await expect(page.getByText("Line achievement")).toBeVisible();
    const pct = page.getByText(/\d+\.\d+%/).first();
    await expect(pct).toBeVisible();
  });

  // ─── Stat Cards ───────────────────────────────────────────────────

  test("all four stat cards are visible", async ({ page }) => {
    await expect(page.getByText("Line Target", { exact: true })).toBeVisible();
    await expect(page.getByText("Line Sales", { exact: true })).toBeVisible();
    await expect(page.getByText("Achievement", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Eligible Reps", { exact: true })).toBeVisible();
  });

  test("stat values show EGP currency format", async ({ page }) => {
    const egpValue = page.getByText(/EGP\s[\d,]+/).first();
    await expect(egpValue).toBeVisible();
  });

  test("eligible reps shows fraction format", async ({ page }) => {
    const fraction = page.getByText(/^\d+ \/ \d+$/);
    await expect(fraction).toBeVisible();
  });

  // ─── Period Filter ────────────────────────────────────────────────

  test("period filter shows All Periods button", async ({ page }) => {
    const allPeriods = page.locator("a").filter({ hasText: "All Periods" });
    await expect(allPeriods).toBeVisible();
  });

  test("period filter shows available periods", async ({ page }) => {
    const periodLink = page.getByText(/\w+ \d{4}/).first();
    await expect(periodLink).toBeVisible();
  });

  test("All Periods is active by default", async ({ page }) => {
    const allPeriodsLink = page.locator("a").filter({ hasText: "All Periods" });
    await expect(allPeriodsLink).toHaveClass(/bg-orange-500/);
  });

  test("clicking a period navigates to filtered view", async ({ page }) => {
    const periodLink = page.locator('a[href*="period="]').first();
    if (await periodLink.isVisible()) {
      await periodLink.click();
      await page.waitForURL(/period=/);
      expect(page.url()).toContain("period=");
    }
  });

  // ─── Achievement Distribution ─────────────────────────────────────

  test("achievement distribution bar is visible", async ({ page }) => {
    await expect(page.getByText("Achievement distribution")).toBeVisible();
  });

  test("achievement distribution shows zone legends", async ({ page }) => {
    await expect(page.getByText(/at 100%\+/)).toBeVisible();
    await expect(page.getByText(/at 90-99%/)).toBeVisible();
    await expect(page.getByText(/at 70-89%/)).toBeVisible();
    await expect(page.getByText(/below 70%/)).toBeVisible();
  });

  // ─── Leaderboard Table ────────────────────────────────────────────

  test("leaderboard section is visible", async ({ page }) => {
    await expect(page.getByText("Leaderboard", { exact: true })).toBeVisible();
    await expect(page.getByText("Medical Reps Comparison")).toBeVisible();
  });

  test("leaderboard table shows column headers on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const nameHeader = page.locator("th").filter({ hasText: "Name" });
    await expect(nameHeader).toBeVisible();
    const achievementHeader = page.locator("th").filter({ hasText: "Achievement" });
    await expect(achievementHeader).toBeVisible();
  });

  test("leaderboard shows ranked members", async ({ page }) => {
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow).toBeVisible();
  });

  test("achievement gap column shows Achieved or EGP gap amounts", async ({ page }) => {
    // The gap column shows either "Achieved" (green) or an EGP amount (red) for each rep
    const achievedCell = page.locator("span.text-green-600").first();
    const gapCell = page.locator("span.text-red-500").first();
    const hasAchieved = await achievedCell.isVisible().catch(() => false);
    const hasGap = await gapCell.isVisible().catch(() => false);
    expect(hasAchieved || hasGap).toBe(true);
  });

  // ─── District-Wise Performance ────────────────────────────────────

  test("district-wise performance section divider is visible", async ({ page }) => {
    await expect(page.getByText(/District-Wise Performance/).first()).toBeVisible({ timeout: 30_000 });
  });

  test("section divider shows district count", async ({ page }) => {
    await expect(page.getByText(/\d+ districts/)).toBeVisible();
  });

  // ─── DSM Group Headers ────────────────────────────────────────────

  test("DSM group header shows manager name", async ({ page }) => {
    const dsmHeader = page.locator("h2").filter({ hasText: /\w+ \w+/ }).nth(2);
    await expect(dsmHeader).toBeVisible();
  });

  test("DSM group shows district achievement percentage", async ({ page }) => {
    const districtPct = page.getByText(/District:/).first();
    await expect(districtPct).toBeVisible({ timeout: 30_000 });
  });

  test("DSM group shows district sales", async ({ page }) => {
    await expect(page.getByText("District sales").first()).toBeVisible();
  });

  // ─── Charts ───────────────────────────────────────────────────────

  test("district achievement ranking chart renders", async ({ page }) => {
    await expect(page.getByText("District Achievement Ranking").first()).toBeVisible();
  });

  test("district sales vs target chart renders", async ({ page }) => {
    await expect(page.getByText("District Sales vs Target").first()).toBeVisible();
  });

  test("charts have ARIA labels for accessibility", async ({ page }) => {
    const achievementChart = page.locator('[role="img"][aria-label*="achievement"]');
    await expect(achievementChart.first()).toBeVisible();
  });

  // ─── Product Breakdown ────────────────────────────────────────────

  test("product breakdown section is visible", async ({ page }) => {
    await expect(page.getByText("Product depth").first()).toBeVisible();
    await expect(page.getByText("Medical Reps Product Breakdown").first()).toBeVisible();
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
    await expect(page.getByText("Line Snapshot")).toBeVisible();
    await expect(page.getByText("Achievement distribution")).toBeVisible();
    await expect(page.getByText("Medical Reps Comparison")).toBeVisible();
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByText("Line Snapshot")).toBeVisible();
    await expect(page.getByText(/District-Wise Performance/)).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.getByText(/Medical Reps Performance|Performance Data Unavailable/i).first(),
    ).toBeVisible();
  });
});
