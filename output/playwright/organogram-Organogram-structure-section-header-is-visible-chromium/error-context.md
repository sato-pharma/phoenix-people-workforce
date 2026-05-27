# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: organogram.spec.ts >> Organogram >> structure section header is visible
- Location: tests\e2e\organogram.spec.ts:111:7

# Error details

```
Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
Call log:
  - navigating to "http://localhost:3000/employee-portals/organogram", waiting until "networkidle"

```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | 
  3   | /**
  4   |  * E2E tests for the Organogram page (/employee-portals/organogram).
  5   |  *
  6   |  * Covers:
  7   |  * - Page load & hero header
  8   |  * - Stat cards with thin gridlines
  9   |  * - Structure completion bar
  10  |  * - Search filter
  11  |  * - Executive hierarchy (CEO → Line → NSM)
  12  |  * - Manager lanes
  13  |  * - Print stylesheet
  14  |  * - RTL support
  15  |  * - Mobile responsiveness
  16  |  * - Error boundary verification
  17  |  *
  18  |  * Run with:  npx playwright test tests/e2e/organogram.spec.ts
  19  |  */
  20  | 
  21  | const BASE_URL = "http://localhost:3000/employee-portals/organogram";
  22  | 
  23  | test.describe("Organogram", () => {
  24  |   test.beforeEach(async ({ page }) => {
> 25  |     await page.goto(BASE_URL, { waitUntil: "networkidle" });
      |                ^ Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
  26  |     await expect(
  27  |       page.locator("h1").filter({ hasText: /Organogram/i }).first(),
  28  |     ).toBeVisible({ timeout: 15_000 });
  29  |   });
  30  | 
  31  |   // ─── Page Load & Hero ─────────────────────────────────────────────
  32  | 
  33  |   test("page loads and displays hero header", async ({ page }) => {
  34  |     await expect(
  35  |       page.locator("h1").filter({ hasText: /Organogram/i }),
  36  |     ).toBeVisible();
  37  |   });
  38  | 
  39  |   test("hero shows people operations badge", async ({ page }) => {
  40  |     const badge = page
  41  |       .locator("section p.text-orange-100")
  42  |       .filter({ hasText: /People Operations/ });
  43  |     await expect(badge).toBeVisible();
  44  |   });
  45  | 
  46  |   // ─── Stat Cards ───────────────────────────────────────────────────
  47  | 
  48  |   test("all five stat cards are visible", async ({ page }) => {
  49  |     await expect(page.getByText("Medical Reps")).toBeVisible();
  50  |     await expect(page.getByText("District Managers")).toBeVisible();
  51  |     await expect(page.getByText("Regional Managers")).toBeVisible();
  52  |     await expect(page.getByText("National Managers")).toBeVisible();
  53  |     await expect(page.getByText("Total Structure")).toBeVisible();
  54  |   });
  55  | 
  56  |   test("stat cards show actual/total values", async ({ page }) => {
  57  |     // Each card shows "actual / total" format
  58  |     const slashSeparator = page.getByText(/\/ \d+/).first();
  59  |     await expect(slashSeparator).toBeVisible();
  60  |   });
  61  | 
  62  |   // ─── Structure Completion ─────────────────────────────────────────
  63  | 
  64  |   test("structure completion section is visible", async ({ page }) => {
  65  |     await expect(page.getByText("Structure Completion")).toBeVisible();
  66  |   });
  67  | 
  68  |   test("structure completion shows filled and vacant legend", async ({ page }) => {
  69  |     const filledLegend = page.getByText(/Filled \d+%/).first();
  70  |     const vacantLegend = page.getByText(/Vacant \d+%/).first();
  71  |     const hasFilled = await filledLegend.isVisible().catch(() => false);
  72  |     const hasVacant = await vacantLegend.isVisible().catch(() => false);
  73  |     expect(hasFilled || hasVacant).toBe(true);
  74  |   });
  75  | 
  76  |   // ─── Filters ──────────────────────────────────────────────────────
  77  | 
  78  |   test("filters section shows filter badge", async ({ page }) => {
  79  |     await expect(
  80  |       page.getByText("Filters", { exact: true }).first(),
  81  |     ).toBeVisible();
  82  |   });
  83  | 
  84  |   test("search input is visible", async ({ page }) => {
  85  |     const searchInput = page.locator(
  86  |       'input[placeholder*="Search name"]',
  87  |     );
  88  |     await expect(searchInput).toBeVisible();
  89  |   });
  90  | 
  91  |   test("refresh button is visible", async ({ page }) => {
  92  |     await expect(
  93  |       page.locator("button").filter({ hasText: "Refresh" }),
  94  |     ).toBeVisible();
  95  |   });
  96  | 
  97  |   // ─── Executive Hierarchy ──────────────────────────────────────────
  98  | 
  99  |   test("CEO hierarchy node is visible", async ({ page }) => {
  100 |     await expect(page.getByText("CEO").first()).toBeVisible();
  101 |   });
  102 | 
  103 |   test("line node is visible", async ({ page }) => {
  104 |     // The line label should be visible in the hierarchy
  105 |     const lineNode = page.getByText("Line", { exact: true }).first();
  106 |     await expect(lineNode).toBeVisible();
  107 |   });
  108 | 
  109 |   // ─── Manager Lanes ────────────────────────────────────────────────
  110 | 
  111 |   test("structure section header is visible", async ({ page }) => {
  112 |     // The section header shows "{Line} Structure"
  113 |     const header = page.getByText(/Structure$/).first();
  114 |     await expect(header).toBeVisible();
  115 |   });
  116 | 
  117 |   test("employee count badge is visible", async ({ page }) => {
  118 |     const badge = page.getByText(/\d+ employees/).first();
  119 |     await expect(badge).toBeVisible();
  120 |   });
  121 | 
  122 |   test("lane count badge is visible", async ({ page }) => {
  123 |     const badge = page.getByText(/\d+ lanes/).first();
  124 |     await expect(badge).toBeVisible();
  125 |   });
```