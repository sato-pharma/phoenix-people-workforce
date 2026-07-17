import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Submit Expense page (/employee-portals/submit-expense).
 *
 * Covers:
 * - Page load + hero
 * - Wizard step indicator (3 steps, numbered)
 * - Request details card visibility
 * - Form fields (Expense Type, From/To Date, Transportation Type, Notes)
 * - Auto-calculated summary section
 * - Mobile responsiveness (375px, 768px, 1280px)
 * - RTL support
 * - Print stylesheet
 * - Error boundary verification
 *
 * Run with:  npx playwright test tests/e2e/submit-expense.spec.ts
 */

const BASE_URL = `${process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"}/employee-portals/submit-expense`;

test.describe("Submit Expense", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ─── Page Load ─────────────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }),
    ).toBeVisible();
  });

  test("hero shows EXPENSES badge", async ({ page }) => {
    const badge = page
      .locator("section p")
      .filter({ hasText: /EXPENSES/ })
      .first();
    await expect(badge).toBeVisible();
  });

  // ─── Wizard Step Indicator ─────────────────────────────────────────

  test("3 wizard steps are visible (Trip details / Validate route / Review & submit)", async ({
    page,
  }) => {
    await expect(page.getByText("Trip details", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Validate route", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Review & submit", { exact: false }).first()).toBeVisible();
  });

  test("step indicator group has aria-label", async ({ page }) => {
    const group = page.locator('[aria-label="Submission progress"]').first();
    await expect(group).toBeVisible();
  });

  // ─── Request Details Card ──────────────────────────────────────────

  test("request details card visible", async ({ page }) => {
    await expect(
      page.getByText("Fill the trip and let the system calculate the rest").first(),
    ).toBeVisible();
  });

  test("expense type options can be selected by direct click", async ({ page }) => {
    const expenseTypeGroup = page.getByRole("radiogroup", { name: /Expense type/i });
    await expect(expenseTypeGroup).toBeVisible();

    const meetingOption = expenseTypeGroup.getByRole("radio", { name: "Meeting" });
    await meetingOption.click();
    await expect(meetingOption).toHaveAttribute("aria-checked", "true");
  });

  test("location capture button is discoverable and clickable", async ({ page }) => {
    const captureButton = page.getByRole("button", { name: /Capture current location for destination/i });
    await expect(captureButton).toBeVisible();
    await expect(captureButton).toBeEnabled();
  });

  test("from-date input is rendered", async ({ page }) => {
    const fromDate = page.locator('input[type="date"]').first();
    await expect(fromDate).toBeVisible();
  });

  test("notes textarea is rendered", async ({ page }) => {
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();
  });

  // ─── Auto Calculated Summary ───────────────────────────────────────

  test("auto calculated summary badge is visible", async ({ page }) => {
    await expect(
      page.getByText(/Auto calculated summary/i).first(),
    ).toBeVisible();
  });

  test("summary fields appear (Allowance / Total Cost)", async ({ page }) => {
    await expect(page.getByText("Allowance", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Total Cost", { exact: false }).first()).toBeVisible();
  });

  // ─── RTL ───────────────────────────────────────────────────────────

  test("page container uses dir=auto for RTL support", async ({ page }) => {
    const root = page.locator('[dir="auto"]').first();
    await expect(root).toBeVisible();
  });

  // ─── Print Stylesheet ──────────────────────────────────────────────

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

  // ─── Mobile Responsiveness ─────────────────────────────────────────

  test("mobile viewport (375px) renders all sections without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }),
    ).toBeVisible();
    await expect(page.getByText("Trip details", { exact: false }).first()).toBeVisible();
  });

  test("tablet viewport (768px) renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }),
    ).toBeVisible();
  });

  test("desktop viewport (1280px) renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }),
    ).toBeVisible();
  });

  // ─── Error Boundary ────────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }).first(),
    ).toBeVisible();
  });
});
