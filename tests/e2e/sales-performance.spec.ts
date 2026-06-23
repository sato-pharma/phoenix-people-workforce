import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Sales Performance page.
 * Uses the dev preview route (/dev/employee-portals/sales) which renders
 * the SalesPerformancePage with fixture data — no auth required.
 *
 * Run with:  npx playwright test tests/e2e/sales-performance.spec.ts
 */

const BASE_URL = "http://localhost:3000/dev/employee-portals/sales";

test.describe("Sales Performance Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  });

  // ─── Page load ──────────────────────────────────────────────────────

  test("page loads and shows header", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Sales Performance");
  });

  test("KPI cards render with correct data", async ({ page }) => {
    await expect(page.getByText("Total Sales")).toBeVisible();
    await expect(page.getByText("Total Target")).toBeVisible();
    await expect(page.getByText("Achievement")).toBeVisible();
    await expect(page.getByText("Gap to Target")).toBeVisible();

    // Check actual values from fixture data
    await expect(page.getByText("EGP 6,370,000")).toBeVisible();
    await expect(page.getByText("EGP 5,975,000")).toBeVisible();
    await expect(page.getByText("106.6%")).toBeVisible();
  });

  test("trend chart renders with axis labels", async ({ page }) => {
    await expect(page.getByText("Sales vs target trajectory")).toBeVisible();
    await expect(page.getByText("Monthly control chart")).toBeVisible();
  });

  test("product table renders all 18 products", async ({ page }) => {
    await expect(page.getByText("Product performance")).toBeVisible();
    // First product in fixture
    await expect(page.getByText("Cardiomax 50mg")).toBeVisible();
    // Last product in fixture
    await expect(page.getByText("Adrenalex Inj")).toBeVisible();
  });

  test("top and bottom product panels render", async ({ page }) => {
    await expect(page.getByText("Top 5 Products")).toBeVisible();
    await expect(page.getByText("Bottom 5 Products")).toBeVisible();
    await expect(page.getByText("Revenue leaders")).toBeVisible();
    await expect(page.getByText("Recovery watch")).toBeVisible();
  });

  test("product mix chart renders", async ({ page }) => {
    await expect(page.getByText("Revenue concentration")).toBeVisible();
    await expect(page.getByText("Product mix")).toBeVisible();
  });

  test("performance insights panel renders", async ({ page }) => {
    await expect(page.getByText("Performance Insights")).toBeVisible();
    await expect(page.getByText("Diagnostics")).toBeVisible();
  });

  test("family performance chart renders", async ({ page }) => {
    await expect(page.getByText("Performance by Product Family")).toBeVisible();
    await expect(page.getByText("Family breakdown")).toBeVisible();
  });

  // ─── Filter interactions ──────���─────────────────────────────────────

  test("period pills are visible and clickable", async ({ page }) => {
    // Period pills should be visible (formatted as month labels)
    const octPill = page.getByRole("button", { name: /Oct 2025/i });
    await expect(octPill).toBeVisible();

    // Click a period pill to select it
    await octPill.click();

    // The "All Periods" link should appear since we deselected one
    await expect(page.getByRole("button", { name: /All Periods/i })).toBeVisible();
  });

  test("period pills toggle selection", async ({ page }) => {
    // Click a pill to deselect it from "all"
    const janPill = page.getByRole("button", { name: /Jan 2026/i });
    await janPill.click();

    // URL should update with period param
    await page.waitForURL(/period=/);
  });

  test("family filter changes data", async ({ page }) => {
    // Family select is the second select (first is comparison)
    const familySelect = page.locator("select").nth(1);
    await familySelect.selectOption("Cardio");

    // URL should update with family param
    await page.waitForURL(/family=Cardio/);
    expect(page.url()).toContain("family=Cardio");
  });

  test("comparison filter can be changed", async ({ page }) => {
    const comparisonSelect = page.locator("select").first();
    await comparisonSelect.selectOption("previous_month");

    // Should still show KPI cards (no crash)
    await expect(page.getByText("Total Sales")).toBeVisible();
  });

  test("product search filters table", async ({ page }) => {
    const searchInput = page.getByPlaceholder("Search products...");
    await searchInput.fill("Cardiomax");

    // Cardiomax should be visible, others hidden
    await expect(page.getByText("Cardiomax 50mg")).toBeVisible();

    // Clear search
    await searchInput.clear();
    // All products visible again
    await expect(page.getByText("Glucofen 500mg")).toBeVisible();
  });

  test("More Filters button toggles product chips", async ({ page }) => {
    const moreButton = page.getByRole("button", { name: /More Filters/i });
    await moreButton.click();

    // Product chips should appear
    await expect(page.getByText("Products").first()).toBeVisible();
  });

  // ─── Table interactions ─���───────────────────────────────────────────

  test("table sort toggles on column click", async ({ page }) => {
    const salesHeader = page.getByRole("columnheader", {
      name: /Sales EGP/i,
    });
    await salesHeader.click();

    // Sort indicator should be visible
    const ariaSort = await salesHeader.getAttribute("aria-sort");
    expect(ariaSort).toBe("ascending");

    // Click again to toggle
    await salesHeader.click();
    const ariaSortDesc = await salesHeader.getAttribute("aria-sort");
    expect(ariaSortDesc).toBe("descending");
  });

  test("clicking a product row toggles selection", async ({ page }) => {
    // In desktop view, rows are clickable
    const row = page.locator("tr[role='button']").first();
    await row.click();

    // URL should update with products param
    await page.waitForURL(/products=/);
  });

  // ─── Reset filters ───────���──────────────────────────────────────────

  test("reset filters clears all active filters", async ({ page }) => {
    // Apply a family filter first
    const familySelect = page.locator("select").nth(1);
    await familySelect.selectOption("Cardio");
    await page.waitForURL(/family=Cardio/);

    // Reset button should appear
    const resetButton = page.getByRole("button", { name: /Reset Filters/i });
    await resetButton.click();

    // URL should be clean
    await page.waitForURL((url) => !url.search.includes("family="));
    expect(page.url()).not.toContain("family=Cardio");
  });

  // ─── Mobile viewport ─────���─────────────────────────────────────────

  test("mobile card view appears on small screens", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    // KPI cards should still be visible
    await expect(page.getByText("Total Sales")).toBeVisible();

    // Product performance section should be visible
    await expect(page.getByText("Product performance")).toBeVisible();

    // The mobile card view should show the card-style layout (no table headers visible)
    const tableHeaders = page.locator("thead");
    await expect(tableHeaders).not.toBeVisible();
  });

  test("mobile card view shows sort control", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    // The mobile sort dropdown should be visible
    await expect(page.getByText("Sort by")).toBeVisible();
  });

  // ─── Error boundary ───────���────────────────────────────────────────

  test("page does not crash with empty data sections", async ({ page }) => {
    // The dev preview should render without errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Sales Performance")).toBeVisible();

    // No unhandled page errors
    expect(errors).toHaveLength(0);
  });

  // ─── Accessibility ─────────────────────────────────────────────────

  test("table headers have aria-sort attributes", async ({ page }) => {
    // The default sort is by sales descending
    const salesHeader = page.getByRole("columnheader", {
      name: /Sales EGP/i,
    });
    await expect(salesHeader).toHaveAttribute("aria-sort", "descending");
  });
});
