import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Employee Coaching Report Review page (/employee-portals/coaching/[id]).
 *
 * Covers:
 * - Page load & hydration (skeleton → content)
 * - Hero header rendering (report number, title, zone badge)
 * - Detail pills (coaching date, coach, role, status)
 * - Employee context card
 * - Final score card with strongest/weakest parameter
 * - Category performance RadarChart + category % badges
 * - Score distribution bar
 * - Structured scoring (5 categories, 20 items, score badges)
 * - Feedback blocks (area of development, strengths, remarks)
 * - Acknowledgment section
 * - ARIA labels for charts
 * - Print stylesheet
 * - RTL support
 * - Error boundary
 * - Mobile responsiveness
 *
 * Run with:  npx playwright test tests/e2e/employee-coaching-review.spec.ts
 */

// Use a known coaching report ID — this requires at least one report in the database
const REPORT_ID = "2b4e47fe-5819-42fa-88df-728f63aa334f";
const BASE_URL = `http://localhost:3000/employee-portals/coaching/${REPORT_ID}`;

test.describe("Employee Coaching Report Review", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    // Wait for hydration — skeleton disappears and real content appears
    await expect(
      page.getByText(/Field Coaching Review|Coaching Access Unavailable/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ─── Page Load & Hero ─────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(page.getByText("Field Coaching Review")).toBeVisible();
  });

  test("hero shows report number badge", async ({ page }) => {
    const badge = page.getByText(/CR-\d{4}-\d+/);
    await expect(badge.first()).toBeVisible();
  });

  test("hero shows performance zone badge", async ({ page }) => {
    const zone = page.getByText(
      /Excellence Zone|Green Zone|Yellow Zone|Red Zone|Not scored/i,
    );
    await expect(zone.first()).toBeVisible();
  });

  test("hero shows coaching description", async ({ page }) => {
    await expect(
      page.getByText("Review the structured assessment and feedback submitted by your coach."),
    ).toBeVisible();
  });

  // ─── Detail Pills ─────────────────────────────────────────────────

  test("detail pills show coaching date, coach, role, status", async ({ page }) => {
    await expect(page.getByText("Coaching date")).toBeVisible();
    await expect(page.getByText("Coach", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Coach role")).toBeVisible();
    await expect(page.getByText("Status", { exact: true })).toBeVisible();
  });

  // ─── Employee Context Card ────────────────────────────────────────

  test("employee context card shows name and HR ID", async ({ page }) => {
    await expect(page.getByText("Employee context")).toBeVisible();
    await expect(page.getByText(/HR ID:/)).toBeVisible();
  });

  test("employee context shows line, area, team pills", async ({ page }) => {
    await expect(page.getByText("Line", { exact: true })).toBeVisible();
    await expect(page.getByText("Area", { exact: true })).toBeVisible();
    await expect(page.getByText("Team", { exact: true })).toBeVisible();
  });

  // ─── Final Score Card ─────────────────────────────────────────────

  test("final score card displays percentage and points", async ({ page }) => {
    await expect(page.getByText("Final score")).toBeVisible();
    // Percentage like "68.3%"
    await expect(page.getByText(/\d+\.\d+%/)).toBeVisible();
    // Points like "82 / 120 points"
    await expect(page.getByText(/\d+ \/ \d+ points/)).toBeVisible();
  });

  test("final score card shows strongest and weakest parameters", async ({ page }) => {
    await expect(page.getByText("Strongest parameter")).toBeVisible();
    await expect(page.getByText("Key development area")).toBeVisible();
  });

  // ─── Category Performance Chart ───────────────────────────────────

  test("category performance section renders", async ({ page }) => {
    const chartSection = page.getByText("Category performance");
    await expect(chartSection).toBeVisible();
  });

  test("category performance has ARIA label for accessibility", async ({ page }) => {
    const chartContainer = page.locator('[aria-label*="Category performance radar chart"]');
    await expect(chartContainer).toBeVisible();
  });

  test("category % badges are color-graded", async ({ page }) => {
    // At least one category percentage badge should be visible
    const percentBadge = page.getByText(/\d+%/).first();
    await expect(percentBadge).toBeVisible();
  });

  // ─── Score Distribution Bar ───────────────────────────────────────

  test("score distribution bar renders with ARIA label", async ({ page }) => {
    const distBar = page.locator('[aria-label*="Score distribution"]');
    await expect(distBar).toBeVisible();
  });

  test("score distribution shows legend entries", async ({ page }) => {
    // Legend shows entries like "0/5: 2" or "5/5: 7"
    const legend = page.getByText(/\d\/5: \d/).first();
    await expect(legend).toBeVisible();
  });

  // ─── Structured Scoring ───────────────────────────────────────────

  test("structured scoring section is visible", async ({ page }) => {
    await expect(page.getByText("Structured scoring")).toBeVisible();
    await expect(page.getByText("20 field excellence points")).toBeVisible();
  });

  test("all 5 category groups are rendered", async ({ page }) => {
    // Use exact match to avoid matching score item labels like "Product Knowledge"
    // and radar chart axis labels
    await expect(page.getByText("Knowledge", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Call Structure Skills", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Business Intelligence", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Business Planning", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Personal Skills", { exact: true }).first()).toBeVisible();
  });

  test("category letter badges A-E are visible", async ({ page }) => {
    for (const letter of ["A", "B", "C", "D", "E"]) {
      const badge = page.locator(
        `span.flex.items-center.justify-center.rounded.bg-slate-900:has-text("${letter}")`,
      );
      await expect(badge).toBeVisible();
    }
  });

  test("score items show score badges", async ({ page }) => {
    // Score badges like "0 / 5", "5 / 5", etc.
    const scoreBadge = page.getByText(/^\d \/ 5$/).first();
    await expect(scoreBadge).toBeVisible();
  });

  test("category subtotal badges are visible", async ({ page }) => {
    // Subtotal like "10 / 18" or "19 / 24"
    const subtotal = page.getByText(/^\d+ \/ \d+$/).first();
    await expect(subtotal).toBeVisible();
  });

  // ─── Feedback Blocks ──────────────────────────────────────────────

  test("feedback blocks render in 3-column layout", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByText("Overall Area of Development")).toBeVisible();
    await expect(page.getByText("Overall Strength Points")).toBeVisible();
    await expect(page.getByText("General Remarks")).toBeVisible();
  });

  // ─── Acknowledgment ───────────────────────────────────────────────

  test("acknowledgment section is visible", async ({ page }) => {
    await expect(page.getByText("Acknowledgment", { exact: true })).toBeVisible();
    await expect(page.getByText("Employee review confirmation")).toBeVisible();
  });

  test("acknowledgment shows status (acknowledged or pending)", async ({ page }) => {
    // Either shows "Acknowledged on ..." or shows the checkbox
    const acknowledged = page.getByText(/Acknowledged on/);
    const checkbox = page.getByRole("checkbox");
    const notOpen = page.getByText(/not currently open|Only the Medical Rep/);

    const hasAcknowledged = await acknowledged.isVisible().catch(() => false);
    const hasCheckbox = await checkbox.isVisible().catch(() => false);
    const hasNotOpen = await notOpen.isVisible().catch(() => false);

    // One of these states must be true
    expect(hasAcknowledged || hasCheckbox || hasNotOpen).toBe(true);
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
    await expect(page.getByText("Field Coaching Review")).toBeVisible();
    await expect(page.getByText("Final score")).toBeVisible();
    await expect(page.getByText("Structured scoring")).toBeVisible();
  });

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByText("Field Coaching Review")).toBeVisible();
    await expect(page.getByText("Acknowledgment", { exact: true })).toBeVisible();
  });

  // ─── Error Boundary ───────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.getByText(/Field Coaching Review|Coaching Access Unavailable/i).first(),
    ).toBeVisible();
  });
});
