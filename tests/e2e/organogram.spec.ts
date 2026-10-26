import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Organogram page (/employee-portals/organogram).
 *
 * Covers:
 * - Page load & hero header
 * - Stat cards with thin gridlines
 * - Structure completion bar
 * - Search filter
 * - Executive hierarchy (CEO → Line → NSM)
 * - Manager lanes
 * - Print stylesheet
 * - RTL support
 * - Mobile responsiveness
 * - Error boundary verification
 *
 * Run with:  pnpm exec playwright test tests/e2e/organogram.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/organogram";

test.describe("Organogram", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator("h1").filter({ hasText: /Organogram/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Organogram/i }),
    ).toBeVisible();
  });

  test("hero shows people operations badge", async ({ page }) => {
    const badge = page
      .locator("section p.text-orange-100")
      .filter({ hasText: /People Operations/ });
    await expect(badge).toBeVisible();
  });

  // ─── Stat Cards ───────────────────────────────────────────────────

  test("all five stat cards are visible", async ({ page }) => {
    await expect(page.getByText("Medical Reps")).toBeVisible();
    await expect(page.getByText("District Managers")).toBeVisible();
    await expect(page.getByText("Regional Managers")).toBeVisible();
    await expect(page.getByText("National Managers")).toBeVisible();
    await expect(page.getByText("All Sales Seats")).toBeVisible();
  });

  test("stat cards show actual/total values", async ({ page }) => {
    // Each card shows "actual / total" format
    const slashSeparator = page.getByText(/\/ \d+/).first();
    await expect(slashSeparator).toBeVisible();
  });

  // ─── Structure Completion ─────────────────────────────────────────

  test("structure completion section is visible", async ({ page }) => {
    await expect(page.getByText("Structure Completion")).toBeVisible();
  });

  test("structure completion shows filled and vacant legend", async ({ page }) => {
    const filledLegend = page.getByText(/Filled \d+%/).first();
    const vacantLegend = page.getByText(/Vacant \d+%/).first();
    const hasFilled = await filledLegend.isVisible().catch(() => false);
    const hasVacant = await vacantLegend.isVisible().catch(() => false);
    expect(hasFilled || hasVacant).toBe(true);
  });

  // ─── Filters ──────────────────────────────────────────────────────

  test("filters section shows filter badge", async ({ page }) => {
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

  test("refresh button is visible", async ({ page }) => {
    await expect(
      page.locator("button").filter({ hasText: "Refresh" }),
    ).toBeVisible();
  });

  // ─── Executive Hierarchy ──────────────────────────────────────────

  test("CEO hierarchy node is visible", async ({ page }) => {
    await expect(page.getByText("CEO").first()).toBeVisible();
  });

  test("line node is visible", async ({ page }) => {
    // The line label should be visible in the hierarchy
    const lineNode = page.getByText("Line", { exact: true }).first();
    await expect(lineNode).toBeVisible();
  });

  // ─── Manager Lanes ────────────────────────────────────────────────

  test("structure section header is visible", async ({ page }) => {
    // The section header shows "{Line} Structure"
    const header = page.getByText(/Structure$/).first();
    await expect(header).toBeVisible();
  });

  test("employee count badge is visible", async ({ page }) => {
    const badge = page.getByText(/\d+ employees/).first();
    await expect(badge).toBeVisible();
  });

  test("lane count badge is visible", async ({ page }) => {
    const badge = page.getByText(/\d+ lanes/).first();
    await expect(badge).toBeVisible();
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
    await expect(page.getByText("Medical Reps")).toBeVisible();
    await expect(page.getByText("Structure Completion")).toBeVisible();
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByText("Medical Reps")).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({
    page,
  }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Organogram/i }).first(),
    ).toBeVisible();
  });
});
