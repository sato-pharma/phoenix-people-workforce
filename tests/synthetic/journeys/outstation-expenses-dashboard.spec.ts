import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

/**
 * The expenses dashboard, which reads through the SAME function the admin queue does.
 *
 * WHY THIS EXISTS. `getPayrollExpenseDashboardData` calls `listUnifiedOutstationExpenses`, and so
 * does `/api/admin/outstation/expenses` — the route that returned 500 for about three and a half
 * hours on 2026-08-12 when PHOENIX_EXPENSE_CLAIMS_READ was turned on before expense_claims had a
 * SELECT policy or a grant. That outage was caught because the queue has a journey. This page reads
 * the same data through the same function and had none, so the flag going back on left it unwatched.
 *
 * WHAT MAKES THIS PAGE EASY TO GET WRONG. It CATCHES its own load failure and renders a banner
 * instead of throwing (page.tsx wraps the call in try/catch and passes `initialError` down). A
 * broken read therefore produces a perfectly healthy-looking 200 with an error card on it. Asserting
 * "the page rendered" would pass through exactly the failure this journey exists to catch — the same
 * trap the Employee 360 journeys guard with SCHEMA_ERROR_TEXT.
 *
 * So the check is the absence of the failure branch AND the presence of something only the success
 * branch renders. The error branch returns early with just a callout; "Review Requests" lives in the
 * hero that only renders when data loaded.
 */
test("Outstation Expenses dashboard loads real analytics", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "outstation-expenses-dashboard",
      name: "Outstation Expenses dashboard loads real analytics",
      route: "/admin/outstation/expenses/dashboard",
      role: "Super Admin",
    },
    async (page) => {
      // The failure branch, which a 200 alone would hide.
      await expect(page.getByText("Unable to load expense analytics")).toHaveCount(0);
      await expect(page.getByText("The expenses dashboard failed to load")).toHaveCount(0);

      // Only rendered once the data actually loaded.
      await expect(page.getByText("Review Requests").first()).toBeVisible();
    },
  );
});
