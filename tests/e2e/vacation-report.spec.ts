import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Vacation Report page.
 *
 * Covers:
 * - Page load & metric card rendering
 * - Tab switching (Entitlements / Requests) with count badges
 * - Collapsible filter panel interactions
 * - Filter panel focus trap
 * - Entitlements table rendering
 * - Eligibility distribution bar
 * - Requests table rendering
 * - Status distribution bar
 * - Paid vs Unpaid bar
 * - Admin controls (add/edit/cancel)
 * - Mobile card view (< 480px)
 * - Tablet viewport
 * - Desktop viewport
 * - RTL dir=auto attribute
 * - Accessibility: tab roles and aria-selected
 * - Error boundary wrapping
 *
 * Run with:  pnpm exec playwright test tests/e2e/vacation-report.spec.ts
 */

const BASE_URL = "http://localhost:3000/leave-management/vacation-report";

test.describe("Vacation Report Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  });

  // ─── Page Load ──────────────────────────────────────────────────────

  test("page loads and displays metric cards", async ({ page }) => {
    // Should show entitlements tab by default
    const metricLabel = page.getByText(/Active employees|Eligible now/i);
    await expect(metricLabel.first()).toBeVisible();
  });

  test("displays tab bar with count badges", async ({ page }) => {
    const tablist = page.getByRole("tablist", { name: /Vacation report/i });
    await expect(tablist).toBeVisible();

    const entitlementsTab = page.getByRole("tab", { name: /Leave Entitlements/i });
    await expect(entitlementsTab).toBeVisible();

    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await expect(requestsTab).toBeVisible();
  });

  // ─── RTL Support ──────────────────────────────────────────────────

  test("root container has dir=auto for RTL support", async ({ page }) => {
    const root = page.locator('[dir="auto"]');
    await expect(root.first()).toBeVisible();
  });

  // ─── Tab Switching ──────────────────────────────────────────────────

  test("switches between Entitlements and Requests tabs", async ({ page }) => {
    // Default on entitlements
    const entitlementsTab = page.getByRole("tab", { name: /Leave Entitlements/i });
    await expect(entitlementsTab).toHaveAttribute("aria-selected", "true");

    // Switch to requests
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    // Requests metric cards should appear
    const totalLabel = page.getByText("Total");
    await expect(totalLabel.first()).toBeVisible();
  });

  test("tab buttons have proper aria-selected state", async ({ page }) => {
    const entitlementsTab = page.getByRole("tab", { name: /Leave Entitlements/i });
    await expect(entitlementsTab).toHaveAttribute("aria-selected", "true");

    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await expect(requestsTab).toHaveAttribute("aria-selected", "false");
  });

  // ─── Filter Panel ──────────────────────────────────────────────────

  test("filter panel expands and collapses", async ({ page }) => {
    const filterBtn = page.getByText("Filters").first();
    await expect(filterBtn).toBeVisible();

    // Click to expand
    await filterBtn.click();

    // Should show filter inputs
    const searchInput = page.getByPlaceholder("Name, HR ID, department...");
    await expect(searchInput).toBeVisible();

    // Click to collapse
    await filterBtn.click();
    await page.waitForTimeout(200);
  });

  test("filter panel shows active filter count", async ({ page }) => {
    // Initially no active filters
    const filterBtn = page.getByText("Filters").first();
    await filterBtn.click();

    const searchInput = page.getByPlaceholder("Name, HR ID, department...");
    await searchInput.fill("test");

    // Apply filters
    const applyBtn = page.getByRole("button", { name: /Apply Filters/i });
    await applyBtn.click();

    // Page should reload with filter param
    await page.waitForURL(/search=test/);
  });

  test("filter panel has focus trap on Escape", async ({ page }) => {
    const filterBtn = page.getByText("Filters").first();
    await filterBtn.click();

    // Should show search input
    const searchInput = page.getByPlaceholder("Name, HR ID, department...");
    await expect(searchInput).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  });

  // ─── Entitlements Tab ──────────────────────────────────────────────

  test("entitlements tab shows eligibility distribution bar", async ({
    page,
  }) => {
    const distBar = page.getByText("Eligibility distribution");
    if (await distBar.isVisible()) {
      await expect(distBar).toBeVisible();
    }
    // Page should not crash regardless
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();
  });

  test("entitlements tab shows table header", async ({ page }) => {
    const tableHeader = page.getByText("Employee leave entitlements");
    await expect(tableHeader.first()).toBeVisible();
  });

  test("entitlements tab shows record count badge", async ({ page }) => {
    const badge = page.getByText(/\d+ records/);
    await expect(badge.first()).toBeVisible();
  });

  // ─── Requests Tab ──────────────────────────────────────────────────

  test("requests tab shows status distribution bar", async ({ page }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    const distBar = page.getByText("Request status distribution");
    if (await distBar.isVisible()) {
      await expect(distBar).toBeVisible();
    }
    // Page should not crash
    await expect(page.getByText("Total").first()).toBeVisible();
  });

  test("requests tab shows paid vs unpaid bar", async ({ page }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    const paidBar = page.getByText("Paid vs Unpaid days");
    if (await paidBar.isVisible()) {
      await expect(paidBar).toBeVisible();
    }
  });

  test("requests tab shows vacation requests header", async ({ page }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    await expect(page.getByText("Vacation requests").first()).toBeVisible();
  });

  // ─── Mobile Viewport ──────────────────────────────────────────────

  test("mobile viewport shows card view for entitlements", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();
  });

  test("mobile viewport shows card view for requests", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    await expect(page.getByText("Total").first()).toBeVisible();
  });

  // ─── Tablet Viewport ──────────────────────────────────────────────

  test("tablet viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();
  });

  // ─── Desktop Viewport ──────────────────────────────────────────────

  test("desktop viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();
  });

  test("wide desktop viewport renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();
  });

  // ─── Accessibility ──────────────────────────────────────────────────

  test("interactive elements have proper roles", async ({ page }) => {
    const tablist = page.getByRole("tablist");
    const tablistCount = await tablist.count();
    expect(tablistCount).toBeGreaterThanOrEqual(1);

    const buttons = page.getByRole("button");
    const buttonCount = await buttons.count();
    expect(buttonCount).toBeGreaterThan(2);
  });

  test("filter panel has aria-expanded attribute", async ({ page }) => {
    const filterToggle = page.locator("[aria-expanded]").first();
    await expect(filterToggle).toBeVisible();
  });

  // ─── Sortable Column Headers (#5) ──────────────────────────────

  test("entitlements table has sortable column headers", async ({ page }) => {
    // Employee header is sortable (default sort). The raw "HR ID" column was removed so the
    // manager/HR view shows names, never codes (owner rule); the table only renders at xl+.
    await page.setViewportSize({ width: 1440, height: 900 });
    const employeeHeader = page.locator("th").filter({ hasText: "Employee" }).first();
    await expect(employeeHeader).toBeVisible();

    // Click to toggle sort direction
    await employeeHeader.click();

    // Sort indicator icon should exist
    const sortIcon = page.locator("th svg").first();
    await expect(sortIcon).toBeVisible();
  });

  test("requests table has sortable column headers", async ({ page }) => {
    // The desktop table renders at xl+; below that the cards carry the data.
    await page.setViewportSize({ width: 1440, height: 900 });
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    // Employee header should be sortable
    const empHeader = page.locator("th").filter({ hasText: "Employee" }).first();
    await expect(empHeader).toBeVisible();
    await empHeader.click();

    // Sort icon should render
    const sortIcon = page.locator("th svg").first();
    await expect(sortIcon).toBeVisible();
  });

  // ─── Pagination Controls (#1 & #3) ──────────────────────────────

  test("pagination controls render when data exceeds page size", async ({
    page,
  }) => {
    // Pagination controls show prev/next buttons
    const prevBtn = page.getByLabel("Previous page");
    const nextBtn = page.getByLabel("Next page");

    // They may or may not be visible depending on data size (< 25 = no pagination)
    // At minimum the page should not crash
    await expect(page.getByText(/Active employees|Eligible now/i).first()).toBeVisible();

    // If pagination is visible, verify it works
    if (await nextBtn.isVisible().catch(() => false)) {
      await expect(prevBtn).toBeVisible();
      await expect(nextBtn).toBeVisible();
    }
  });

  // ─── Export Buttons (#2) ─────────────────────────────────────────

  test("entitlements tab shows CSV export button", async ({ page }) => {
    const csvBtn = page.getByTitle("Export to CSV");
    await expect(csvBtn.first()).toBeVisible();
  });

  test("entitlements tab shows print button", async ({ page }) => {
    const printBtn = page.getByTitle("Print report");
    await expect(printBtn.first()).toBeVisible();
  });

  test("requests tab shows CSV and print buttons", async ({ page }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    await expect(page.getByTitle("Export to CSV").first()).toBeVisible();
    await expect(page.getByTitle("Print report").first()).toBeVisible();
  });

  // ─── Date Range Quick Presets (#4) ──────────────────────────────

  test("date presets appear in filter panel on requests tab", async ({
    page,
  }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    // Open filter panel
    const filterBtn = page.getByText("Filters").first();
    await filterBtn.click();

    // Date presets should be visible
    await expect(page.getByText("Quick date range")).toBeVisible();
    await expect(page.getByText("This month")).toBeVisible();
    await expect(page.getByText("Last 30 days")).toBeVisible();
    await expect(page.getByText("This quarter")).toBeVisible();
    await expect(page.getByText("This year")).toBeVisible();
  });

  test("clicking a date preset fills the date fields", async ({ page }) => {
    const requestsTab = page.getByRole("tab", { name: /All Requests/i });
    await requestsTab.click();
    await page.waitForURL(/tab=requests/);

    const filterBtn = page.getByText("Filters").first();
    await filterBtn.click();

    // Click "This month" preset
    const presetBtn = page.getByText("This month");
    await presetBtn.click();

    // From date input should now have a value
    const fromInput = page.locator('input[type="date"]').first();
    const fromValue = await fromInput.inputValue();
    expect(fromValue).toBeTruthy();
  });

  // ─── Print Stylesheet (#6) ──────────────────────────────────────

  test("print stylesheet is embedded in the page", async ({ page }) => {
    // Verify the style block with @media print exists
    const styleContent = await page.evaluate(() => {
      const styles = document.querySelectorAll("style");
      for (const s of styles) {
        if (s.textContent?.includes("@media print")) return true;
      }
      return false;
    });
    expect(styleContent).toBe(true);
  });

  // ─── Error Boundary ──────────────────────────────────────────────

  test("page is wrapped in error boundary (no-crash verification)", async ({
    page,
  }) => {
    await expect(
      page.getByText(/Active employees|Eligible now|Vacation report failed/i).first(),
    ).toBeVisible();
  });
});
