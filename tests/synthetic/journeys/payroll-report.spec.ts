import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Payroll Report loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "payroll-report", name: "Payroll Report loads", route: "/payroll", role: "Super Admin" },
    async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: /Payroll/i })).toBeVisible();
    },
  );
});
